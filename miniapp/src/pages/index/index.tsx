import type { CSSProperties } from "react";
import { View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import Home from "../../../../app/page";

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

export default function Index() {
  useShareAppMessage(() => {
    const bridge = (globalThis as typeof globalThis & {
      __TIGAME_PLATFORM__?: { getShareRoomId?: () => string };
    }).__TIGAME_PLATFORM__;
    const roomId = bridge?.getShareRoomId?.() || "";
    return {
      title: roomId ? `加入 TiGame 房间 ${roomId}` : "TiGame｜线下桌游小助手",
      path: roomId ? `/pages/index/index?invite=${encodeURIComponent(roomId)}` : "/pages/index/index",
    };
  });

  return (
    <View className="miniapp-root" style={miniappLayoutVars()}>
      <Home />
    </View>
  );
}
