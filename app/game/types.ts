export type GameId = "undercover" | "challenge" | "mahjong";

export type Player = {
  id: string;
  name: string;
  color: string;
  online: boolean;
  isHost?: boolean;
  /** 小程序用户主动选择的微信头像缩略图（data URL，服务端限制大小）。 */
  avatarData?: string;
  /** 服务器内部记录玩家断开连接的毫秒时间戳，不会下发给客户端。 */
  offlineSince?: number;
  /** 对局中途加入，下一局才自动进入当前游戏（仅当前对局有效）。 */
  joinNextRound?: boolean;
};

export type PublicPlayer = Omit<Player, "offlineSince">;

export type PendingJoinRequest = {
  id: string;
  playerName: string;
  /** 申请者在微信头像填写能力中主动选择的头像缩略图。 */
  avatarData?: string;
  createdAt: number;
};

export type RoomSettings = {
  maxPlayers: number;
};

/** 房间最高人数：系统固定为 16，不可修改。 */
export const ROOM_MAX_PLAYERS = 16;

export type GameDefinition = {
  id: GameId;
  name: string;
  tagline: string;
  description: string;
  symbol: string;
  minPlayers: number;
};

export const GAME_LIST: GameDefinition[] = [
  {
    id: "undercover",
    name: "谁是卧底",
    tagline: "找出卧底",
    description: "每人拿到一个词语，轮流描述后投票找出卧底。",
    symbol: "🕵️",
    minPlayers: 3,
  },
  {
    id: "challenge",
    name: "不要做挑战",
    tagline: "忍住别犯规",
    description: "每人抽一张禁忌动作，犯规就会被惩罚，最后一个留下的获胜。",
    symbol: "🚫",
    minPlayers: 2,
  },
  {
    id: "mahjong",
    name: "麻将计分板",
    tagline: "记账更轻松",
    description: "点击头像送出分数。",
    symbol: "🀄",
    minPlayers: 2,
  },
];

export function sanitizeRoomSettings(
  _value: Partial<RoomSettings> | undefined,
  _fallback: RoomSettings,
): RoomSettings {
  void _value;
  void _fallback;
  return { maxPlayers: ROOM_MAX_PLAYERS };
}

