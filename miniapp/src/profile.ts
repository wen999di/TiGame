import Taro from "@tarojs/taro";

const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v3";

export type WechatMiniProfile = {
  nickname: string;
  avatarData: string;
};

export function readWechatProfile(): WechatMiniProfile | null {
  try {
    const value = Taro.getStorageSync(WECHAT_PROFILE_STORAGE_KEY) as Partial<WechatMiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<WechatMiniProfile> : value;
    const rawNickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const nickname = rawNickname === "微信用户" ? "" : rawNickname;
    const avatarData = typeof parsed?.avatarData === "string" ? parsed.avatarData : "";
    return nickname && avatarData ? { nickname, avatarData } : null;
  } catch {
    return null;
  }
}
