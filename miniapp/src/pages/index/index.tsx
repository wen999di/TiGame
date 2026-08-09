import { useEffect, useState, type CSSProperties } from "react";
import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import Home from "../../../../app/page";
import { makeAvatarThumbnail, readWechatProfile, saveWechatProfile, type WechatMiniProfile } from "../../profile";

declare const __TIGAME_API_BASE__: string;


function networkFailureHint(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("domain") || lower.includes("url not in domain list")) return "微信 request 合法域名配置阻止了请求";
  if (lower.includes("ssl") || lower.includes("tls") || lower.includes("certificate")) return "HTTPS/TLS 证书握手失败";
  if (lower.includes("timeout")) return "请求超时";
  if (lower.includes("dns") || lower.includes("resolve")) return "DNS 解析失败";
  return "微信网络层未能连接到该域名";
}

async function checkApiDomainReachability() {
  const url = __TIGAME_API_BASE__.replace(/\/$/, "");
  const startedAt = Date.now();
  void Taro.showLoading({ title: "正在检查域名…", mask: true });
  try {
    const response = await Taro.request({
      url,
      method: "GET",
      dataType: "text",
      timeout: 15000,
    });
    const elapsed = Date.now() - startedAt;
    Taro.hideLoading();
    await Taro.showModal({
      title: "域名自检通过",
      content: `${url}\nHTTP ${response.statusCode} · ${elapsed}ms\n微信小程序已能访问该域名。`,
      showCancel: false,
    });
  } catch (reason) {
    const elapsed = Date.now() - startedAt;
    Taro.hideLoading();
    const message = typeof (reason as { errMsg?: unknown })?.errMsg === "string"
      ? (reason as { errMsg: string }).errMsg
      : String(reason);
    await Taro.showModal({
      title: "域名自检失败",
      content: `${networkFailureHint(message)}\n${url}\n${elapsed}ms\n${message}`.slice(0, 500),
      showCancel: false,
    });
  }
}

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
  useEffect(() => {
    void checkApiDomainReachability();
  }, []);
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
