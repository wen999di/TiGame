import type { AvatarMime } from "../game/avatar-frame";

type MiniProfile = {
  nickname: string;
  avatarPath?: string;
  avatarMime?: AvatarMime;
};

type MiniProfileEditorProps = {
  profile: MiniProfile | null;
  onProfileChange: (profile: MiniProfile | null) => void;
};

export function MiniProfileEditor(_props: MiniProfileEditorProps) {
  return null;
}
