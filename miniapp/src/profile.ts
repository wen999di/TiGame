import Taro from "@tarojs/taro";
import type { AvatarMime } from "../../app/game/avatar-frame";

const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v4";
const USER_DATA_PATH = Taro.env.USER_DATA_PATH || "";
const roomAvatarPaths = new Set<string>();

export type WechatMiniProfile = {
  nickname: string;
  avatarPath: string;
  avatarMime: AvatarMime;
};

function isAvatarMime(value: unknown): value is AvatarMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

export function readWechatProfile(): WechatMiniProfile | null {
  try {
    const value = Taro.getStorageSync(WECHAT_PROFILE_STORAGE_KEY) as Partial<WechatMiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<WechatMiniProfile> : value;
    const rawNickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const nickname = rawNickname === "微信用户" ? "" : rawNickname;
    const avatarPath = typeof parsed?.avatarPath === "string" ? parsed.avatarPath : "";
    const avatarMime = isAvatarMime(parsed?.avatarMime) ? parsed.avatarMime : null;
    return nickname && avatarPath && avatarMime ? { nickname, avatarPath, avatarMime } : null;
  } catch {
    return null;
  }
}

export function readAvatarBinary(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      success: (result) => {
        if (result.data instanceof ArrayBuffer) resolve(result.data);
        else reject(new Error("头像文件不是二进制数据"));
      },
      fail: reject,
    });
  });
}

function avatarExtension(mime: AvatarMime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export function cacheRoomAvatarBinary(
  roomId: string,
  playerId: string,
  mime: AvatarMime,
  bytes: ArrayBuffer,
): Promise<string> {
  const safeRoom = roomId.replace(/[^A-Za-z0-9-]/g, "");
  const safePlayer = playerId.replace(/[^A-Za-z0-9-]/g, "");
  const filePath = `${USER_DATA_PATH}/tigame-room-${safeRoom}-${safePlayer}.${avatarExtension(mime)}`;
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().writeFile({
      filePath,
      data: bytes,
      success: () => {
        roomAvatarPaths.add(filePath);
        resolve(filePath);
      },
      fail: reject,
    });
  });
}

export function clearRoomAvatarCache() {
  const fs = Taro.getFileSystemManager();
  const remove = (filePath: string) => {
    try {
      fs.unlink({ filePath, fail: () => {} });
    } catch {
      // Best-effort local cache cleanup only.
    }
  };
  for (const filePath of roomAvatarPaths) remove(filePath);
  roomAvatarPaths.clear();
  // 上次如果被系统直接杀进程，内存集合来不及清理；下次启动顺手删除残留房间头像。
  try {
    fs.readdir({
      dirPath: USER_DATA_PATH,
      success: (result) => {
        for (const fileName of result.files ?? []) {
          if (/^tigame-room-/.test(fileName)) remove(`${USER_DATA_PATH}/${fileName}`);
        }
      },
      fail: () => {},
    });
  } catch {
    // Older runtimes may not expose readdir; current-session cleanup still works.
  }
}

export { WECHAT_PROFILE_STORAGE_KEY };
