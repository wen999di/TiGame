import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";

type MiniProfile = {
  nickname: string;
  avatarData?: string;
};

type MiniProfileEditorProps = {
  profile: MiniProfile | null;
  onProfileChange: (profile: MiniProfile | null) => void;
};


const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v2";
const AVATAR_DATA_MAX = 4096;

function readProfileDraft(): Partial<MiniProfile> {
  try {
    const value = Taro.getStorageSync(WECHAT_PROFILE_STORAGE_KEY) as Partial<MiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<MiniProfile> : value;
    const nickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const avatarData = typeof parsed?.avatarData === "string" ? parsed.avatarData : "";
    return { ...(nickname ? { nickname } : {}), ...(avatarData ? { avatarData } : {}) };
  } catch {
    return {};
  }
}

function saveProfileDraft(changes: Partial<MiniProfile>): Partial<MiniProfile> {
  const current = readProfileDraft();
  const nicknameSource = changes.nickname === undefined ? current.nickname : changes.nickname;
  const avatarSource = changes.avatarData === undefined ? current.avatarData : changes.avatarData;
  const nickname = typeof nicknameSource === "string" ? nicknameSource.trim().slice(0, 12) : "";
  const avatarData = typeof avatarSource === "string" ? avatarSource : "";
  const next = { ...(nickname ? { nickname } : {}), ...(avatarData ? { avatarData } : {}) };
  Taro.setStorageSync(WECHAT_PROFILE_STORAGE_KEY, next);
  return next;
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

async function localAvatarPath(source: string): Promise<string> {
  const info = await Taro.getImageInfo({ src: source }).catch(() => null);
  if (info?.path) return info.path;
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await Taro.downloadFile({ url: source });
    if (downloaded.statusCode < 200 || downloaded.statusCode >= 300 || !downloaded.tempFilePath) {
      throw new Error("微信头像下载失败，请重试");
    }
    return downloaded.tempFilePath;
  }
  return source;
}

async function makeAvatarThumbnail(source: string): Promise<string> {
  const localSource = await localAvatarPath(source);
  const attempts = [
    { size: 48, quality: 58 },
    { size: 36, quality: 42 },
    { size: 32, quality: 32 },
  ];
  for (const attempt of attempts) {
    const compressed = await Taro.compressImage({
      src: localSource,
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

type AvatarEvent = { detail?: { avatarUrl?: string } };
type NicknameEvent = { detail?: { value?: string } };

export function MiniProfileEditor({ profile, onProfileChange }: MiniProfileEditorProps) {
  const stored = readProfileDraft();
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
    const next = saveProfileDraft(changes);
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
