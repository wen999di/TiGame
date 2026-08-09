import Taro from "@tarojs/taro";

export const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v2";
const AVATAR_DATA_MAX = 4096;

export type WechatMiniProfile = {
  nickname: string;
  avatarData: string;
};

export function readWechatProfile(): WechatMiniProfile | null {
  try {
    const value = Taro.getStorageSync(WECHAT_PROFILE_STORAGE_KEY) as Partial<WechatMiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<WechatMiniProfile> : value;
    const nickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const avatarData = typeof parsed?.avatarData === "string" ? parsed.avatarData : "";
    return nickname && avatarData ? { nickname, avatarData } : null;
  } catch {
    return null;
  }
}

export function saveWechatProfile(profile: WechatMiniProfile) {
  Taro.setStorageSync(WECHAT_PROFILE_STORAGE_KEY, profile);
}

export async function requestWechatProfile(): Promise<WechatMiniProfile> {
  const cached = readWechatProfile();
  if (cached) return cached;
  const result = await Taro.getUserProfile({ desc: "用于游戏中显示微信头像和昵称" });
  const nickname = result.userInfo.nickName.trim().slice(0, 12);
  const avatarUrl = result.userInfo.avatarUrl || "";
  if (!nickname || !avatarUrl) throw new Error("微信没有返回昵称或头像，请重试");
  const profile = { nickname, avatarData: await makeAvatarThumbnail(avatarUrl) };
  saveWechatProfile(profile);
  return profile;
}

function readFileBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      success: (result) => resolve(String(result.data ?? "")),
      fail: reject,
    });
  });
}

async function localAvatarPath(source: string): Promise<string> {
  const info = await Taro.getImageInfo({ src: source }).catch(() => null);
  if (info?.path) return info.path;
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await Taro.downloadFile({ url: source });
    if (downloaded.statusCode < 200 || downloaded.statusCode >= 300 || !downloaded.tempFilePath) {
      throw new Error("微信头像下载失败，请重试");
    }
    return downloaded.tempFilePath;
  }
  return source;
}

export async function makeAvatarThumbnail(source: string): Promise<string> {
  const localSource = await localAvatarPath(source);
  const attempts = [
    { size: 48, quality: 58 },
    { size: 36, quality: 42 },
    { size: 32, quality: 32 },
  ];
  for (const attempt of attempts) {
    const compressed = await Taro.compressImage({
      src: localSource,
      quality: attempt.quality,
      compressedWidth: attempt.size,
      compressedHeight: attempt.size,
    });
    const info = await Taro.getImageInfo({ src: compressed.tempFilePath }).catch(() => null);
    const rawType = String(info?.type || "jpeg").toLowerCase();
    const type = rawType === "jpg" ? "jpeg" : /^(jpeg|png|webp)$/.test(rawType) ? rawType : "jpeg";
    const base64 = await readFileBase64(compressed.tempFilePath);
    const dataUrl = `data:image/${type};base64,${base64}`;
    if (dataUrl.length <= AVATAR_DATA_MAX) return dataUrl;
  }
  throw new Error("头像压缩后仍然过大，请换一张图片");
}
