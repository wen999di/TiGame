import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { makeAvatarThumbnail, readWechatProfileDraft, saveWechatProfileDraft } from "../profile";

type MiniProfile = {
  nickname: string;
  avatarData?: string;
};

type MiniProfileEditorProps = {
  profile: MiniProfile | null;
  onProfileChange: (profile: MiniProfile | null) => void;
};

type AvatarEvent = { detail?: { avatarUrl?: string } };
type NicknameEvent = { detail?: { value?: string } };

export function MiniProfileEditor({ profile, onProfileChange }: MiniProfileEditorProps) {
  const stored = readWechatProfileDraft();
  const [draft, setDraft] = useState<MiniProfile>(() => ({
    nickname: profile?.nickname || stored.nickname || "",
    avatarData: profile?.avatarData || stored.avatarData || "",
  }));
  const [avatarBusy, setAvatarBusy] = useState(false);

  useEffect(() => {
    onProfileChange(draft);
    // 只在组件进入页面时把已缓存的草稿同步给共享页面。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateDraft = (changes: Partial<MiniProfile>) => {
    const next = saveWechatProfileDraft(changes);
    const normalized = { nickname: next.nickname || "", avatarData: next.avatarData || "" };
    setDraft(normalized);
    onProfileChange(normalized);
  };

  const chooseAvatar = async (event: AvatarEvent) => {
    const avatarUrl = event.detail?.avatarUrl || "";
    if (!avatarUrl || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const avatarData = await makeAvatarThumbnail(avatarUrl);
      updateDraft({ avatarData });
    } catch (error) {
      console.error("[TiGame miniapp] avatar processing failed", error);
      void Taro.showToast({ title: "头像处理失败，请重试", icon: "none" });
    } finally {
      setAvatarBusy(false);
    }
  };

  const updateNickname = (event: NicknameEvent) => {
    updateDraft({ nickname: String(event.detail?.value || "").slice(0, 12) });
  };

  return (
    <View className="miniapp-profile-editor">
      <View className="miniapp-avatar-field">
        <Text className="miniapp-profile-label">微信头像</Text>
        <Button
          className={`miniapp-avatar-button${draft.avatarData ? " has-avatar" : ""}`}
          openType="chooseAvatar"
          onChooseAvatar={chooseAvatar as never}
          disabled={avatarBusy}
        >
          {draft.avatarData ? (
            <Image className="miniapp-avatar-image" src={draft.avatarData} mode="aspectFill" />
          ) : (
            <View className="miniapp-avatar-placeholder"><Text>＋</Text></View>
          )}
        </Button>
        <Text className="miniapp-profile-help">{avatarBusy ? "正在处理头像…" : "点击头像选择微信头像"}</Text>
      </View>
      <View className="miniapp-nickname-field">
        <Text className="miniapp-profile-label">微信昵称</Text>
        <Input
          className="miniapp-nickname-input"
          type="nickname"
          value={draft.nickname}
          maxlength={12}
          placeholder="点击选择或填写微信昵称"
          onInput={updateNickname as never}
          confirmType="done"
        />
        <Text className="miniapp-profile-help">点击输入框后可使用微信提供的昵称</Text>
      </View>
    </View>
  );
}
