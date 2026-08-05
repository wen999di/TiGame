/**
 * 邀请码规范化：兼容“ABC-123”与不带横杠的“ABC123”。
 * 统一去掉横杠（以及空格等干扰字符）后按 3-3 重新插入，作为房间 ID 的规范形式。
 */
export const ROOM_ID_PATTERN = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

export function normalizeRoomId(input: string | null | undefined): string {
  const compact = (input ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{6}$/.test(compact) ? `${compact.slice(0, 3)}-${compact.slice(3)}` : compact;
}