import Taro from "@tarojs/taro";

const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v2";

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
