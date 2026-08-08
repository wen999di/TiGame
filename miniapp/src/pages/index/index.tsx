import { useShareAppMessage } from "@tarojs/taro";
import Home from "../../../../app/page";

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
  return <Home />;
}
