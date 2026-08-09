/* eslint-disable jsx-a11y/alt-text -- Taro Image does not expose the HTML alt prop */
import { useMemo, useState } from "react";
import { Button, Image, Input, Text, View, WebView } from "@tarojs/components";
import Taro, { useLoad, useShareAppMessage } from "@tarojs/taro";

declare const __TIGAME_WEB_BASE__: string;

const PROFILE_STORAGE_KEY = "tigame:wechat-profile:v1";
const AVATAR_DATA_MAX = 4_096;

type MiniProfile = {
  nickname: string;
  avatarData: string;
};

function normalizeInvite(value: unknown) {
  const invite = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 7) : "";
  return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(invite) ? invite : "";
}

function readStoredProfile(): MiniProfile | null {
  try {
    const value = Taro.getStorageSync(PROFILE_STORAGE_KEY) as Partial<MiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<MiniProfile> : value;
    const nickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const avatarData = typeof parsed?.avatarData === "string" ? parsed.avatarData : "";
    return nickname && avatarData ? { nickname, avatarData } : null;
  } catch {
    return null;
  }
}

function saveProfile(profile: MiniProfile) {
  Taro.setStorageSync(PROFILE_STORAGE_KEY, profile);
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

async function thumbnailDataUrl(source: string): Promise<string> {
  const attempts = [
    { size: 48, quality: 58 },
    { size: 36, quality: 42 },
    { size: 32, quality: 32 },
  ];
  for (const attempt of attempts) {
    const compressed = await Taro.compressImage({
      src: source,
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

function webViewSrc(profile: MiniProfile, invite: string) {
  const base = __TIGAME_WEB_BASE__.replace(/\/$/, "");
  const query = invite ? `?invite=${encodeURIComponent(invite)}` : "";
  const payload = encodeURIComponent(JSON.stringify({ v: 1, nickname: profile.nickname, avatarData: profile.avatarData }));
  return `${base}/${query}#tigame-wx-profile=${payload}`;
}

function inviteFromWebViewUrl(value?: string) {
  if (!value) return "";
  const match = value.match(/[?&]invite=([A-Za-z0-9-]+)/);
  return normalizeInvite(match?.[1] ?? "");
}

function initialInvite() {
  try {
    return normalizeInvite(Taro.getCurrentInstance?.().router?.params?.invite || Taro.getLaunchOptionsSync().query?.invite);
  } catch {
    return "";
  }
}

export default function Index() {
  const [invite, setInvite] = useState(() => initialInvite());
  const [profile, setProfile] = useState<MiniProfile | null>(() => readStoredProfile());
  const [nickname, setNickname] = useState(() => profile?.nickname ?? "");
  const [avatarData, setAvatarData] = useState(() => profile?.avatarData ?? "");
  const [avatarPreview, setAvatarPreview] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState("");

  useLoad((options) => {
    setInvite(normalizeInvite(options?.invite));
  });

  useShareAppMessage((payload) => {
    const roomId = inviteFromWebViewUrl(payload.webViewUrl) || invite;
    return {
      title: roomId ? `加入 TiGame 房间 ${roomId}` : "TiGame｜线下桌游小助手",
      path: roomId ? `/pages/index/index?invite=${encodeURIComponent(roomId)}` : "/pages/index/index",
    };
  });

  const src = useMemo(() => profile ? webViewSrc(profile, invite) : "", [profile, invite]);

  const chooseAvatar = async (event: { detail?: { avatarUrl?: string } }) => {
    const path = event.detail?.avatarUrl || "";
    if (!path) return;
    setAvatarBusy(true);
    setError("");
    setAvatarPreview(path);
    try {
      setAvatarData(await thumbnailDataUrl(path));
    } catch (reason) {
      setAvatarData("");
      setError(reason instanceof Error ? reason.message : "头像处理失败，请重试");
    } finally {
      setAvatarBusy(false);
    }
  };

  const enterTiGame = () => {
    const cleanName = nickname.trim().slice(0, 12);
    if (!cleanName) {
      setError("请选择或填写昵称");
      return;
    }
    if (!avatarData) {
      setError("请先选择微信头像");
      return;
    }
    const next = { nickname: cleanName, avatarData };
    saveProfile(next);
    setProfile(next);
  };

  if (profile && src) {
    return <WebView src={src} />;
  }

  return (
    <View className="profile-shell">
      <Text className="profile-eyebrow">微信资料</Text>
      <Text className="profile-title">进入 TiGame</Text>
      <Text className="profile-hint">头像和昵称只用于当前游戏房间里的玩家识别。头像会压缩为小缩略图，不写入长期用户数据库。</Text>
      <View className="profile-card">
        <Button className="avatar-button" openType="chooseAvatar" onChooseAvatar={chooseAvatar} disabled={avatarBusy}>
          {avatarPreview ? <Image className="avatar-preview" src={avatarPreview} mode="aspectFill" /> : <Text className="avatar-placeholder">选择头像</Text>}
        </Button>
        <Text className="profile-label">昵称</Text>
        <Input
          className="profile-input"
          type="nickname"
          maxlength={12}
          value={nickname}
          placeholder="点击使用微信昵称"
          onInput={(event) => setNickname(event.detail.value)}
        />
        <Button className="profile-submit" onClick={enterTiGame} disabled={avatarBusy}>{avatarBusy ? "正在处理头像…" : "进入 TiGame"}</Button>
        {error ? <Text className="profile-error">{error}</Text> : null}
      </View>
      <Text className="profile-privacy">资料仅在本机保存用于下次进入；服务器侧头像只随房间 Durable Object 存活，房间销毁时一并清除。</Text>
    </View>
  );
}
