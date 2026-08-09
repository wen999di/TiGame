import { useState, type CSSProperties } from "react";
import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import Home from "../../../../app/page";
import { makeAvatarThumbnail, readWechatProfile, saveWechatProfile, type WechatMiniProfile } from "../../profile";

function miniappLayoutVars(): CSSProperties {
  let statusBarHeight = 24;
  let menuClearance = 96;
  let navHeight = 52;
  try {
    const windowInfo = Taro.getWindowInfo?.();
    statusBarHeight = Math.max(20, Number(windowInfo?.statusBarHeight || statusBarHeight));
    const menu = Taro.getMenuButtonBoundingClientRect?.();
    if (menu && windowInfo?.windowWidth) {
      menuClearance = Math.max(88, Math.ceil(windowInfo.windowWidth - menu.left + 12));
      navHeight = Math.max(44, Math.ceil(menu.bottom - statusBarHeight + 8));
    }
  } catch {
    // Conservative values above still keep content below the status bar/capsule.
  }
  return {
    "--tigame-status-bar-height": `${statusBarHeight}px`,
    "--tigame-menu-clearance": `${menuClearance}px`,
    "--tigame-nav-height": `${navHeight}px`,
  } as CSSProperties;
}

function ProfileGate({ onReady }: { onReady: (profile: WechatMiniProfile) => void }) {
  const [nickname, setNickname] = useState("");
  const [avatarData, setAvatarData] = useState("");
  const [avatarPreview, setAvatarPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseAvatar = async (event: { detail?: { avatarUrl?: string } }) => {
    const path = event.detail?.avatarUrl || "";
    if (!path) return;
    setBusy(true);
    setError("");
    setAvatarPreview(path);
    try {
      setAvatarData(await makeAvatarThumbnail(path));
    } catch (reason) {
      setAvatarData("");
      setError(reason instanceof Error ? reason.message : "头像处理失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const cleanName = nickname.trim().slice(0, 12);
    if (!avatarData) return setError("请先选择微信头像");
    if (!cleanName) return setError("请选择或填写昵称");
    const profile = { nickname: cleanName, avatarData };
    saveWechatProfile(profile);
    onReady(profile);
  };

  return <View className="wechat-profile-shell">
    <Text className="wechat-profile-eyebrow">微信资料</Text>
    <Text className="wechat-profile-title">进入 TiGame</Text>
    <Text className="wechat-profile-hint">头像和昵称只用于游戏中的玩家识别。头像仅保存在本机和当前房间，不写入长期数据库。</Text>
    <View className="wechat-profile-card">
      <Button className="wechat-avatar-button" openType="chooseAvatar" onChooseAvatar={chooseAvatar} disabled={busy}>
        {avatarPreview ? <Image className="wechat-avatar-preview" src={avatarPreview} mode="aspectFill" /> : <Text>选择头像</Text>}
      </Button>
      <Text className="wechat-profile-label">昵称</Text>
      <Input className="wechat-profile-input" type="nickname" maxlength={12} value={nickname} placeholder="点击使用微信昵称" onInput={(event) => setNickname(event.detail.value)} />
      <Button className="wechat-profile-submit" onClick={submit} disabled={busy}>{busy ? "正在处理头像…" : "进入 TiGame"}</Button>
      {error ? <Text className="wechat-profile-error">{error}</Text> : null}
    </View>
  </View>;
}

export default function Index() {
  const [profile, setProfile] = useState<WechatMiniProfile | null>(() => readWechatProfile());
  useShareAppMessage(() => {
    const bridge = (globalThis as typeof globalThis & { __TIGAME_PLATFORM__?: { getShareRoomId?: () => string } }).__TIGAME_PLATFORM__;
    const roomId = bridge?.getShareRoomId?.() || "";
    return {
      title: roomId ? `加入 TiGame 房间 ${roomId}` : "TiGame｜线下桌游小助手",
      path: roomId ? `/pages/index/index?invite=${encodeURIComponent(roomId)}` : "/pages/index/index",
    };
  });
  return <View className="miniapp-root" style={miniappLayoutVars()}>
    {profile ? <Home /> : <ProfileGate onReady={setProfile} />}
  </View>;
}
