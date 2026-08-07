const MAX_AVATAR_DATA_LENGTH = 4096;

function compress(src, quality, size) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality,
      compressedWidth: size,
      compressedHeight: size,
      success: (res) => resolve(res.tempFilePath),
      fail: reject,
    });
  });
}

function readBase64(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: reject,
    });
  });
}

function savePreview(base64, name = 'profile') {
  const safeName = String(name || 'avatar').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'avatar';
  const path = `${wx.env.USER_DATA_PATH}/tigame-avatar-${safeName}.jpg`;
  return new Promise((resolve) => {
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: base64,
      encoding: 'base64',
      success: () => resolve(path),
      fail: () => resolve(''),
    });
  });
}

async function prepareAvatar(src) {
  const attempts = [
    { quality: 54, size: 56 },
    { quality: 38, size: 48 },
    { quality: 24, size: 40 },
  ];
  for (const item of attempts) {
    try {
      const compressed = await compress(src, item.quality, item.size);
      const base64 = await readBase64(compressed);
      const data = `data:image/jpeg;base64,${base64}`;
      if (data.length <= MAX_AVATAR_DATA_LENGTH) {
        const previewPath = await savePreview(base64);
        return { avatarData: data, avatarPreview: previewPath || compressed };
      }
    } catch {}
  }
  throw new Error('头像压缩后仍然过大，请换一张头像');
}

function restorePreview(avatarData) {
  if (!avatarData || !avatarData.includes(',')) return Promise.resolve('');
  return savePreview(avatarData.slice(avatarData.indexOf(',') + 1), 'profile');
}

function materializeAvatar(avatarData, cacheName) {
  if (!avatarData || !avatarData.includes(',')) return Promise.resolve('');
  return savePreview(avatarData.slice(avatarData.indexOf(',') + 1), cacheName);
}

module.exports = { prepareAvatar, restorePreview, materializeAvatar };
