type MiniProfile = {
  nickname: string;
  avatarData?: string;
};

type MiniProfileEditorProps = {
  profile: MiniProfile | null;
  onProfileChange: (profile: MiniProfile | null) => void;
};

export function MiniProfileEditor(_props: MiniProfileEditorProps) {
  return null;
}
