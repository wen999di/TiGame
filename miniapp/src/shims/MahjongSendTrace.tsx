import { View } from "@tarojs/components";

export function MahjongSendTrace({ active }: { active: boolean }) {
  return (
    <View
      className={`mahjong-send-trace miniapp-mahjong-send-trace${active ? " mahjong-send-trace-active" : ""}`}
      aria-hidden="true"
    >
      <View className="miniapp-mahjong-send-trace-runner" />
    </View>
  );
}
