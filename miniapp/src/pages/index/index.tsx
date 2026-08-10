import { WebView } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";

declare const __TIGAME_API_BASE__: string;
const WEB_APP_URL = __TIGAME_API_BASE__.replace(/\/$/, "");

function currentInvite() {
  const value = Taro.getCurrentInstance().router?.params?.invite;
  return typeof value === "string" ? value.trim() : "";
}

function webViewUrl() {
  const params = ["source=weapp-webview"];
  const invite = currentInvite();
  if (invite) params.push(`invite=${encodeURIComponent(invite)}`);
  return `${WEB_APP_URL}/?${params.join("&")}`;
}

export default function Index() {
  useShareAppMessage(() => {
    const invite = currentInvite();
    return {
      title: invite ? `加入 TiGame 房间 ${invite}` : "TiGame｜线下桌游小助手",
      path: invite ? `/pages/index/index?invite=${encodeURIComponent(invite)}` : "/pages/index/index",
    };
  });

  return <WebView src={webViewUrl()} />;
}
