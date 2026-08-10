import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { MAX_AVATAR_BYTES, type AvatarMime } from "../../../app/game/avatar-frame";

const WECHAT_PROFILE_STORAGE_KEY = "tigame:wechat-profile:v4";

function readAvatarBinary(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      success: (result) => {
        if (result.data instanceof ArrayBuffer) resolve(result.data);
        else reject(new Error("头像文件不是二进制数据"));
      },
      fail: reject,
    });
  });
}

type MiniProfile = {
  nickname: string;
  avatarPath?: string;
  avatarMime?: AvatarMime;
};

type MiniProfileEditorProps = {
  profile: MiniProfile | null;
  onProfileChange: (profile: MiniProfile | null) => void;
};

function isAvatarMime(value: unknown): value is AvatarMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function readProfileDraft(): Partial<MiniProfile> {
  try {
    const value = Taro.getStorageSync(WECHAT_PROFILE_STORAGE_KEY) as Partial<MiniProfile> | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<MiniProfile> : value;
    const rawNickname = typeof parsed?.nickname === "string" ? parsed.nickname.trim().slice(0, 12) : "";
    const nickname = rawNickname === "微信用户" ? "" : rawNickname;
    const avatarPath = typeof parsed?.avatarPath === "string" ? parsed.avatarPath : "";
    const avatarMime = isAvatarMime(parsed?.avatarMime) ? parsed.avatarMime : undefined;
    return {
      ...(nickname ? { nickname } : {}),
      ...(avatarPath && avatarMime ? { avatarPath, avatarMime } : {}),
    };
  } catch {
    return {};
  }
}

function saveProfileDraft(changes: Partial<MiniProfile>): Partial<MiniProfile> {
  const current = readProfileDraft();
  const nicknameSource = changes.nickname === undefined ? current.nickname : changes.nickname;
  const avatarPathSource = changes.avatarPath === undefined ? current.avatarPath : changes.avatarPath;
  const avatarMimeSource = changes.avatarMime === undefined ? current.avatarMime : changes.avatarMime;
  const rawNickname = typeof nicknameSource === "string" ? nicknameSource.trim().slice(0, 12) : "";
  const nickname = rawNickname === "微信用户" ? "" : rawNickname;
  const avatarPath = typeof avatarPathSource === "string" ? avatarPathSource : "";
  const avatarMime = isAvatarMime(avatarMimeSource) ? avatarMimeSource : undefined;
  const next = {
    ...(nickname ? { nickname } : {}),
    ...(avatarPath && avatarMime ? { avatarPath, avatarMime } : {}),
  };
  Taro.setStorageSync(WECHAT_PROFILE_STORAGE_KEY, next);
  return next;
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

function normalizeMime(type: unknown): AvatarMime {
  const value = String(type || "jpeg").toLowerCase();
  if (value === "png") return "image/png";
  if (value === "webp") return "image/webp";
  return "image/jpeg";
}

function persistAvatarFile(tempFilePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.saveFile({
      tempFilePath,
      success: (result) => resolve(result.savedFilePath),
      fail: reject,
    });
  });
}

async function makeAvatarThumbnail(source: string): Promise<{ avatarPath: string; avatarMime: AvatarMime }> {
  const localSource = await localAvatarPath(source);
  const attempts = [
    { size: 160, quality: 80 },
    { size: 144, quality: 76 },
    { size: 128, quality: 72 },
    { size: 112, quality: 68 },
  ];
  for (const attempt of attempts) {
    const compressed = await Taro.compressImage({
      src: localSource,
      quality: attempt.quality,
      compressedWidth: attempt.size,
      compressedHeight: attempt.size,
    });
    const bytes = await readAvatarBinary(compressed.tempFilePath);
    if (bytes.byteLength > MAX_AVATAR_BYTES) continue;
    const info = await Taro.getImageInfo({ src: compressed.tempFilePath }).catch(() => null);
    const avatarPath = await persistAvatarFile(compressed.tempFilePath);
    if (!avatarPath) continue;
    return { avatarPath, avatarMime: normalizeMime(info?.type) };
  }
  throw new Error("头像压缩后仍然过大，请换一张图片");
}

type AvatarEvent = { detail?: { avatarUrl?: string } };
type NicknameEvent = { detail?: { value?: string } };

export function MiniProfileEditor({ profile, onProfileChange }: MiniProfileEditorProps) {
  const stored = readProfileDraft();
  const [draft, setDraft] = useState<MiniProfile>(() => ({
    nickname: profile?.nickname || stored.nickname || "",
    avatarPath: profile?.avatarPath || stored.avatarPath || "",
    avatarMime: profile?.avatarMime || stored.avatarMime,
  }));
  const [avatarBusy, setAvatarBusy] = useState(false);

  useEffect(() => {
    onProfileChange(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateDraft = (changes: Partial<MiniProfile>) => {
    const next = saveProfileDraft(changes);
    const normalized: MiniProfile = {
      nickname: next.nickname || "",
      avatarPath: next.avatarPath || "",
      avatarMime: next.avatarMime,
    };
    setDraft(normalized);
    onProfileChange(normalized);
  };

  const chooseAvatar = async (event: AvatarEvent) => {
    const avatarUrl = event.detail?.avatarUrl || "";
    if (!avatarUrl || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const previousPath = draft.avatarPath;
      const nextAvatar = await makeAvatarThumbnail(avatarUrl);
      updateDraft(nextAvatar);
      if (previousPath && previousPath !== nextAvatar.avatarPath) {
        void Taro.removeSavedFile({ filePath: previousPath }).catch(() => {});
      }
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
        <Text className="miniapp-profile-label">头像</Text>
        <Button
          className={`miniapp-avatar-button${draft.avatarPath ? " has-avatar" : ""}`}
          openType="chooseAvatar"
          onChooseAvatar={chooseAvatar as never}
          disabled={avatarBusy}
        >
          {draft.avatarPath ? (
            <Image className="miniapp-avatar-image" src={draft.avatarPath} mode="aspectFill" />
          ) : (
            <View className="miniapp-avatar-placeholder"><Text>＋</Text></View>
          )}
        </Button>
        <Text className="miniapp-profile-help">{avatarBusy ? "正在处理头像…" : "点击头像选择微信头像"}</Text>
      </View>
      <View className="miniapp-nickname-field">
        <Text className="miniapp-profile-label">昵称</Text>
        <Input
          className="miniapp-nickname-input"
          type="nickname"
          value={draft.nickname}
          maxlength={12}
          placeholder="点击输入框选择微信昵称"
          onInput={updateNickname as never}
          confirmType="done"
        />
      </View>
    </View>
  );
}
