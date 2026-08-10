import { GAME_LIST, ROOM_MAX_PLAYERS, type GameId, type Player, type PendingJoinRequest, type RoomSettings } from "./types.ts";
import {
  DEFAULT_UNDERCOVER_SETTINGS,
  createUndercoverState,
  maxUndercoverForPlayers,
  publicUndercoverState,
  resolveVoting,
  settleUndercoverRemoval,
  type UndercoverPublicState,
  type UndercoverState,
} from "./undercover.ts";
import {
  DEFAULT_CHALLENGE_SETTINGS,
  createChallengeState,
  publicChallengeState,
  settleChallengeRemoval,
  type ChallengePublicState,
  type ChallengeState,
} from "./challenge.ts";
import {
  createMahjongState,
  publicMahjongState,
  settleMahjongRemoval,
  type MahjongPublicState,
  type MahjongState,
} from "./mahjong.ts";

export { GAME_LIST, ROOM_MAX_PLAYERS, sanitizeRoomSettings, type GameId, type Player, type PendingJoinRequest, type RoomSettings } from "./types.ts";

export type RoomPhase = "LOBBY" | "GAME";

export type GameState = UndercoverState | ChallengeState | MahjongState;
export type PublicGameState = UndercoverPublicState | ChallengePublicState | MahjongPublicState;

/**
 * 通用房间状态：房间本身只负责玩家、在线状态与当前选择的游戏，
 * 各小游戏的具体状态放在 gameState 中，由对应游戏模块维护。
 */
export type RoomState = {
  roomId: string;
  hostId: string;
  createdAt: number;
  /** 每次有效状态变化 +1，客户端据此忽略旧连接/旧快照的延迟消息。 */
  revision: number;
  /** 所有玩家都离线的时间点（全员离线超过时限后房间自动销毁）。 */
  allOfflineSince?: number;
  settings: RoomSettings;
  players: Player[];
  phase: RoomPhase;
  gameId: GameId | null;
  gameState: GameState | null;
  pendingJoinRequests: PendingJoinRequest[];
  /** 房主是否暂时离开对局、只在大厅里邀请玩家（其余玩家继续对局）。 */
  hostInLobby: boolean;
};

/** 下发给客户端的内容：gameState 中的私密字段由各游戏模块的投影函数剔除。 */
export type PublicRoom = {
  roomId: string;
  hostId: string;
  createdAt: number;
  revision: number;
  settings: RoomSettings;
  players: Array<Omit<Player, "offlineSince">>;
  phase: RoomPhase;
  gameId: GameId | null;
  game: PublicGameState | null;
  pendingJoinRequests: PendingJoinRequest[];
  hostInLobby: boolean;
};

export const PLAYER_COLORS = ["sage", "gold", "blue", "plum", "mint", "rose", "slate", "sun"];

function projectGameState(
  gameId: GameId,
  gameState: GameState,
  viewerPlayerId: string | null,
): PublicGameState {
  switch (gameId) {
    case "undercover":
      return publicUndercoverState(gameState as UndercoverState);
    case "challenge":
      return publicChallengeState(gameState as ChallengeState, viewerPlayerId);
    case "mahjong":
      return publicMahjongState(gameState as MahjongState);
  }
}

/**
 * 按查看者投影房间状态：
 * - 待批准申请列表只有房主可见（B012）；
 * - 各游戏私密字段由对应游戏的投影函数按 viewerPlayerId 裁剪。
 * viewer 为空时采用最安全默认（不暴露任何待批准申请、不暴露挑战牌面）。
 */
export function publicRoom(
  state: RoomState,
  viewer?: { playerId: string; isHost: boolean } | null,
): PublicRoom {
  return {
    roomId: state.roomId,
    hostId: state.hostId,
    createdAt: state.createdAt,
    revision: state.revision,
    settings: state.settings,
    players: state.players.map((player) => {
      const { offlineSince: _offlineSince, ...publicPlayer } = player;
      void _offlineSince;
      return publicPlayer;
    }),
    phase: state.phase,
    gameId: state.gameId,
    game: state.gameId && state.gameState
      ? projectGameState(state.gameId, state.gameState, viewer?.playerId ?? null)
      : null,
    pendingJoinRequests: viewer?.isHost ? state.pendingJoinRequests : [],
    hostInLobby: state.hostInLobby,
  };
}

export function createRoomState(
  roomId: string,
  hostId: string,
  hostName: string,
  settings: RoomSettings,
): RoomState {
  return {
    roomId,
    hostId,
    createdAt: Date.now(),
    revision: 0,
    allOfflineSince: Date.now(),
    settings,
    players: [{
      id: hostId,
      name: hostName.slice(0, 12) || "房主",
      color: "coral",
      online: false,
      isHost: true,
      offlineSince: Date.now(),
    }],
    phase: "LOBBY",
    gameId: null,
    gameState: null,
    pendingJoinRequests: [],
    hostInLobby: false,
  };
}

/** 房主在大厅选择一个小游戏：谁是卧底先进设置阶段，其余游戏直接开始。 */
export function enterGame(
  state: RoomState,
  gameId: GameId,
  randomNumber: () => number = Math.random,
): { state: RoomState; sendCards: boolean } {
  if (state.phase !== "LOBBY" || state.gameId) return { state, sendCards: false };
  const definition = GAME_LIST.find((game) => game.id === gameId);
  if (!definition || state.players.length < definition.minPlayers) return { state, sendCards: false };

  let gameState: GameState;
  let sendCards = false;
  switch (gameId) {
    case "undercover": {
      // 先进入设置阶段：房主配置好本局规则后，再点击“开始游戏”发第一局牌。
      gameState = createUndercoverState(DEFAULT_UNDERCOVER_SETTINGS);
      sendCards = false;
      break;
    }
    case "challenge": {
      // 同样先进设置阶段：房主配置好生命数后，再点击“开始游戏”发牌。
      gameState = createChallengeState(DEFAULT_CHALLENGE_SETTINGS);
      sendCards = false;
      break;
    }
    case "mahjong": {
      gameState = createMahjongState(state.players);
      sendCards = false;
      break;
    }
  }
  return { state: { ...state, phase: "GAME", gameId, gameState, hostInLobby: false }, sendCards };
}

/** 返回大厅：清空当前游戏状态，保留玩家。 */
export function backToLobby(state: RoomState): RoomState {
  return { ...state, phase: "LOBBY", gameId: null, gameState: null, hostInLobby: false };
}

/** 房主暂时离开当前对局回到大厅：游戏状态保留，其余玩家继续对局。 */
export function hostToLobby(state: RoomState): RoomState {
  if (state.phase !== "GAME" || !state.gameId) return state;
  return { ...state, hostInLobby: true };
}

/** 房主从大厅返回当前对局。 */
export function hostReturnToGame(state: RoomState): RoomState {
  if (state.phase !== "GAME" || !state.gameId) return state;
  return { ...state, hostInLobby: false };
}

/** 谁是卧底投票结算：被淘汰的玩家标记为“出局”，留在房间里观战。 */
export function resolveUndercoverVote(
  state: RoomState,
  randomNumber: () => number = Math.random,
): { state: RoomState } {
  if (state.gameId !== "undercover" || !state.gameState) return { state };
  const resolved = resolveVoting(state.gameState as UndercoverState, state.players, randomNumber);
  return {
    state: {
      ...state,
      gameState: resolved.state,
    },
  };
}

/** 玩家被移出后（踢出/离开），交给当前游戏自动推进。
 * removedPlayer 为被移出的玩家（主动离开或被踢），用于立即判定卧底退出等胜负规则。
 */
export function settleAfterRemoval(
  state: RoomState,
  randomNumber: () => number = Math.random,
  removedPlayer?: Player | null,
): { state: RoomState; sendCards: boolean } {
  let result: { state: RoomState; sendCards: boolean };
  if (!state.gameId || !state.gameState) {
    result = { state, sendCards: false };
  } else {
    switch (state.gameId) {
      case "undercover": {
        const gameResult = settleUndercoverRemoval(state.gameState as UndercoverState, state.players, randomNumber, removedPlayer);
        // 被踢/离开的玩家已由 kickPlayer 从 players 移除；投票淘汰的玩家
        // 记在 gameState.eliminatedPlayerIds 里留在房间观战，不在这里过滤。
        result = {
          state: { ...state, gameState: gameResult.state },
          sendCards: gameResult.started,
        };
        break;
      }
      case "challenge": {
        result = {
          state: { ...state, gameState: settleChallengeRemoval(state.gameState as ChallengeState, state.players) },
          sendCards: false,
        };
        break;
      }
      case "mahjong": {
        result = {
          state: { ...state, gameState: settleMahjongRemoval(state.gameState as MahjongState, state.players) },
          sendCards: false,
        };
        break;
      }
      default:
        result = { state, sendCards: false };
        break;
    }
  }
  // 卧底人数必须严格小于总人数的一半；中途有人被移出（踢出/离开，断线不算）
  // 导致当前设定不满足时，自动下调到满足要求的最大数字。
  if (result.state.gameId === "undercover" && result.state.gameState) {
    const game = result.state.gameState as UndercoverState;
    const maxUndercover = maxUndercoverForPlayers(result.state.players.length);
    if (game.settings.undercover > maxUndercover) {
      result = {
        ...result,
        state: {
          ...result.state,
          gameState: { ...game, settings: { ...game.settings, undercover: maxUndercover } },
        },
      };
    }
  }
  return result;
}

export function addPendingRequest(state: RoomState, request: PendingJoinRequest): RoomState {
  return { ...state, pendingJoinRequests: [...state.pendingJoinRequests, request] };
}

export function approveJoinRequest(
  state: RoomState,
  requestId: string,
  connected: boolean,
): { state: RoomState; request: PendingJoinRequest | null } {
  const request = state.pendingJoinRequests.find((item) => item.id === requestId) ?? null;
  if (!request || state.players.length >= ROOM_MAX_PLAYERS) {
    return { state, request: null };
  }
  // 防御：申请提交后房间内才出现同名玩家（含断线玩家）时，拒绝批准，避免重名。
  if (state.players.some((player) => player.name === request.playerName)) {
    return { state, request: null };
  }
  const player: Player = {
    id: request.id,
    name: request.playerName,
    color: PLAYER_COLORS[state.players.length % PLAYER_COLORS.length],
    online: connected,
  };
  return {
    state: {
      ...state,
      players: [...state.players, player],
      pendingJoinRequests: state.pendingJoinRequests.filter((item) => item.id !== requestId),
    },
    request,
  };
}

export function rejectJoinRequest(state: RoomState, requestId: string): RoomState {
  return {
    ...state,
    pendingJoinRequests: state.pendingJoinRequests.filter((item) => item.id !== requestId),
  };
}

export function kickPlayer(state: RoomState, targetId: string): RoomState {
  return {
    ...state,
    players: state.players.filter((player) => player.id !== targetId),
  };
}
