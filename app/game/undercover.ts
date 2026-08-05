import {
  chooseWordPair,
  createRoundResult,
  dealCards,
  updatePlayerResponse,
  type DealtCard,
  type RoundResult,
  type WordBankScope,
  type WordPair,
} from "./deal-cards.ts";
import { GAME_LIST, type Player } from "./types.ts";

export { updatePlayerResponse };

/** 进入下一局需要的最少人数（与游戏定义一致）。 */
const UNDERCOVER_MIN_PLAYERS = GAME_LIST.find((item) => item.id === "undercover")?.minPlayers ?? 3;

export type UndercoverPhase = "SETUP" | "PLAYING" | "VOTING" | "REVEALED";
export type Winner = "civilians" | "undercover";

export type UndercoverSettings = {
  undercover: number;
  blank: number;
  /** 词库范围（可多选）：1 轻松 / 2 标准 / 3 烧脑，发牌时从所选范围随机抽取。 */
  scopes: WordBankScope[];
};

export const DEFAULT_UNDERCOVER_SETTINGS: UndercoverSettings = { undercover: 1, blank: 0, scopes: [1] };

export type SecretCard = Omit<DealtCard, "playerId">;

/** 一轮投票的公开结果。 */
export type VoteResult = {
  round: number;
  /** 每位得票玩家的票数、名字与投给他的玩家 id（从高到低排序）。 */
  voteCounts: Array<{ playerId: string; playerName: string; count: number; voterIds: string[] }>;
  /** 本轮被淘汰的玩家；没有任何有效票时为空字符串。 */
  eliminatedPlayerId: string;
  eliminatedPlayerName: string;
  /** 最高票是否出现平票（由服务器随机决定淘汰对象）。 */
  tie: boolean;
  /** 游戏是否就此结束以及胜方；null 表示游戏继续。 */
  winner: Winner | null;
  /** 游戏结束时的完整揭晓信息（词与身份）；游戏继续时为空。 */
  reveal: {
    normalWord: string;
    undercoverWord: string;
    category: string;
    undercoverPlayers: Array<{ playerId: string; playerName: string; color: string }>;
    blankPlayers: Array<{ playerId: string; playerName: string; color: string }>;
  } | null;
};

/**
 * “谁是卧底”的独立游戏状态。
 * `cards`、`votes`、`lastWordPair` 是服务器内部数据，绝不广播给客户端。
 */
export type UndercoverState = {
  phase: UndercoverPhase;
  round: number;
  /** 玩家 id -> 私密牌面。 */
  cards: Record<string, SecretCard>;
  /** 已点击“开始投票”的玩家（PLAYING 阶段）。 */
  voteReadyPlayerIds: string[];
  /** 私密投票表：投票人 id -> 被投玩家 id。 */
  votes: Record<string, string>;
  voteResult: VoteResult | null;
  winner: Winner | null;
  nextRoundReadyPlayerIds: string[];
  /** 全员已准备但人数不足最低要求时置 true，禁止进入下一局。 */
  nextRoundBlocked: boolean;
  /** 本局已被投票淘汰、留在房间里观战的玩家（不参与后续发牌与投票）。 */
  eliminatedPlayerIds: string[];
  roundResult: RoundResult | null;
  lastWordPair: WordPair | null;
  settings: UndercoverSettings;
  /** 当前对局内的胜负记录（赢X局/输X局），返回大厅后随游戏状态清空。 */
  records: Record<string, { wins: number; losses: number }>;
};

export type UndercoverPublicState = Omit<
  UndercoverState,
  "cards" | "votes" | "lastWordPair" | "roundResult"
> & {
  kind: "undercover";
  /** 已经提交投票的玩家（只用于展示进度，不公开投给谁）。 */
  votedPlayerIds: string[];
};

export function createUndercoverState(settings: UndercoverSettings): UndercoverState {
  return {
    phase: "SETUP",
    round: 0,
    cards: {},
    voteReadyPlayerIds: [],
    votes: {},
    voteResult: null,
    winner: null,
    nextRoundReadyPlayerIds: [],
    nextRoundBlocked: false,
    eliminatedPlayerIds: [],
    roundResult: null,
    lastWordPair: null,
    settings,
    records: {},
  };
}

export function publicUndercoverState(state: UndercoverState): UndercoverPublicState {
  const { cards, votes, lastWordPair, roundResult, ...rest } = state;
  void cards;
  void votes;
  void lastWordPair;
  // roundResult 里的 normalWord/undercoverWord/undercoverPlayerIds 属于完整身份信息，
  // 只允许在游戏结束后的 voteResult.reveal 中公开；PLAYING/VOTING 阶段绝不能下发。
  void roundResult;
  return { ...rest, kind: "undercover", votedPlayerIds: Object.keys(votes) };
}

export function secretCardFrom(dealtCard: DealtCard): SecretCard {
  return {
    round: dealtCard.round,
    word: dealtCard.word,
    isBlank: dealtCard.isBlank,
    category: dealtCard.category,
  };
}

/** 发新一局，给包括离线玩家在内的所有人发牌。 */
export function startUndercoverRound(
  state: UndercoverState,
  players: readonly Player[],
  randomNumber: () => number = Math.random,
): { state: UndercoverState; cards: Record<string, SecretCard> } {
  const wordPair = chooseWordPair(state.settings.scopes, randomNumber, state.lastWordPair ?? undefined);
  const round = state.round + 1;
  const dealtCards = dealCards(
    players.map((player) => player.id),
    state.settings,
    wordPair,
    round,
    randomNumber,
  );
  const cards = Object.fromEntries(dealtCards.map((card) => [card.playerId, secretCardFrom(card)]));
  return {
    state: {
      ...state,
      phase: "PLAYING",
      round,
      cards,
      // 淘汰只在当局有效：进入下一局后所有人都重新参与。
      eliminatedPlayerIds: [],
      voteReadyPlayerIds: [],
      votes: {},
      voteResult: null,
      winner: null,
      nextRoundReadyPlayerIds: [],
      nextRoundBlocked: false,
      roundResult: null,
      lastWordPair: wordPair,
    },
    cards,
  };
}

function buildRoundResult(state: UndercoverState, players: readonly Player[]): RoundResult | null {
  if (!state.lastWordPair) return null;
  const dealtCards: DealtCard[] = players.map((player) => {
    const card = state.cards[player.id];
    return {
      playerId: player.id,
      round: state.round,
      word: card?.word ?? state.lastWordPair!.normal,
      isBlank: card?.isBlank ?? false,
      category: card?.category ?? state.lastWordPair!.category,
    };
  });
  return createRoundResult(dealtCards, state.lastWordPair);
}

function revealFromRoundResult(roundResult: RoundResult, players: readonly Player[]) {
  const nameOf = (playerId: string) => players.find((player) => player.id === playerId)?.name ?? "未知玩家";
  const colorOf = (playerId: string) => players.find((player) => player.id === playerId)?.color ?? "slate";
  return {
    normalWord: roundResult.normalWord,
    undercoverWord: roundResult.undercoverWord,
    category: roundResult.category,
    undercoverPlayers: roundResult.undercoverPlayerIds.map((id) => ({ playerId: id, playerName: nameOf(id), color: colorOf(id) })),
    blankPlayers: roundResult.blankPlayerIds.map((id) => ({ playerId: id, playerName: nameOf(id), color: colorOf(id) })),
  };
}

/** 判定胜负：卧底全部出局 -> 平民胜利；卧底仍在且场上只剩两人 -> 卧底胜利；否则游戏继续。 */
function computeWinner(
  roundResult: RoundResult | null,
  players: readonly Player[],
): Winner | null {
  const undercoverIds = roundResult?.undercoverPlayerIds ?? [];
  const undercoversStillIn = undercoverIds.some((id) => players.some((player) => player.id === id));
  if (!undercoversStillIn) return "civilians";
  if (players.length <= 2) return "undercover";
  return null;
}

export function allPlayersResponded(
  players: readonly { id: string }[],
  responsePlayerIds: readonly string[],
) {
  const responses = new Set(responsePlayerIds);
  return players.length > 0 && players.every((player) => responses.has(player.id));
}

/** 本局实际参与游戏的玩家（排除“下一局才加入”的新人和已被淘汰的观战者）。 */
function activePlayers(players: readonly Player[], state: Pick<UndercoverState, "eliminatedPlayerIds">) {
  const eliminated = new Set(state.eliminatedPlayerIds);
  return players.filter((player) => !player.joinNextRound && !eliminated.has(player.id));
}

/** 一局结束后按胜方更新每人胜/负局数。 */
function applyRoundRecords(
  records: Record<string, { wins: number; losses: number }>,
  players: readonly Player[],
  roundResult: RoundResult | null,
  winner: Winner,
): Record<string, { wins: number; losses: number }> {
  const undercoverIds = new Set(roundResult?.undercoverPlayerIds ?? []);
  const next = { ...records };
  for (const player of players) {
    const isUndercover = undercoverIds.has(player.id);
    const win = winner === "undercover" ? isUndercover : !isUndercover;
    const prev = next[player.id] ?? { wins: 0, losses: 0 };
    next[player.id] = win
      ? { wins: prev.wins + 1, losses: prev.losses }
      : { wins: prev.wins, losses: prev.losses + 1 };
  }
  return next;
}

/** 全员点击“开始投票”后进入投票环节。 */
export function applyVoteReady(
  state: UndercoverState,
  players: readonly Player[],
  playerId: string,
  ready: boolean,
): { state: UndercoverState; started: boolean } {
  if (state.phase !== "PLAYING") return { state, started: false };
  // “下一局才加入”的新人不参与本局投票，也不能提交准备。
  const active = activePlayers(players, state);
  if (!active.some((player) => player.id === playerId)) return { state, started: false };
  const voteReadyPlayerIds = updatePlayerResponse(state.voteReadyPlayerIds, playerId, ready);
  // 有人再次“准备投票”时清空上一轮投票结果，避免客户端重新弹出结果页。
  const nextState: UndercoverState = { ...state, voteReadyPlayerIds, voteResult: null, roundResult: null };
  if (!allPlayersResponded(active, voteReadyPlayerIds)) {
    return { state: nextState, started: false };
  }
  return {
    state: { ...nextState, phase: "VOTING", votes: {}, voteReadyPlayerIds: [] },
    started: true,
  };
}

/** 提交/更新一张私密选票；只有指向其他玩家的有效票才会被记录。 */
export function applyVote(
  state: UndercoverState,
  players: readonly Player[],
  voterId: string,
  targetId: string,
): { state: UndercoverState; done: boolean } {
  if (state.phase !== "VOTING") return { state, done: false };
  const active = activePlayers(players, state);
  const voter = active.find((player) => player.id === voterId);
  const target = active.find((player) => player.id === targetId);
  if (!voter || !target || targetId === voterId) return { state, done: false };
  const votes = { ...state.votes, [voterId]: targetId };
  const nextState: UndercoverState = { ...state, votes };
  const done = allPlayersResponded(active, Object.keys(votes));
  return { state: nextState, done };
}

/**
 * 所有玩家投票结束后结算：
 * - 卧底全部被投出 -> 平民胜利；
 * - 卧底未出局且场上只剩两人 -> 卧底胜利；
 * - 否则淘汰最高票玩家；平票不淘汰任何人，回到“准备投票”重新投票（B049）。
 * 被投票淘汰的玩家留在房间里观战（记入 eliminatedPlayerIds），不从这里移除。
 */
export function resolveVoting(
  state: UndercoverState,
  players: readonly Player[],
  randomNumber: () => number = Math.random,
): { state: UndercoverState; eliminatedPlayerId: string } {
  if (state.phase !== "VOTING") return { state, eliminatedPlayerId: "" };

  const active = activePlayers(players, state);
  const nameOf = (playerId: string) => active.find((player) => player.id === playerId)?.name ?? "未知玩家";
  const counts = new Map<string, number>();
  for (const player of active) {
    const targetId = state.votes[player.id];
    if (targetId && targetId !== player.id && active.some((item) => item.id === targetId)) {
      counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const voteCounts = ranked.map(([playerId, count]) => ({
    playerId,
    playerName: nameOf(playerId),
    count,
    voterIds: Object.entries(state.votes)
      .filter(([, targetId]) => targetId === playerId)
      .map(([voterId]) => voterId),
  }));
  if (ranked.length === 0) {
    // 没有任何有效票：无人出局，回到本局（结果页由各玩家本地关闭）。
    return {
      state: {
        ...state,
        phase: "PLAYING",
        votes: {},
        voteReadyPlayerIds: [],
        nextRoundReadyPlayerIds: [],
        voteResult: {
          round: state.round,
          voteCounts: [],
          eliminatedPlayerId: "",
          eliminatedPlayerName: "",
          tie: false,
          winner: null,
          reveal: null,
        },
      },
      eliminatedPlayerId: "",
    };
  }

  const topCount = ranked[0][1];
  const tied = ranked.filter((entry) => entry[1] === topCount).map((entry) => entry[0]);
  const tie = tied.length > 1;

  if (tie) {
    // 平票不淘汰任何人：回到“准备投票”，全员重新准备后再投一次。
    return {
      state: {
        ...state,
        phase: "PLAYING",
        votes: {},
        voteReadyPlayerIds: [],
        nextRoundReadyPlayerIds: [],
        voteResult: {
          round: state.round,
          voteCounts,
          eliminatedPlayerId: "",
          eliminatedPlayerName: "",
          tie: true,
          winner: null,
          reveal: null,
        },
      },
      eliminatedPlayerId: "",
    };
  }

  const eliminatedPlayerId = tied[0];

  const roundResult = buildRoundResult(state, active);
  const remainingPlayers = active.filter((player) => player.id !== eliminatedPlayerId);
  const winner = computeWinner(roundResult, remainingPlayers);

  const reveal = winner && roundResult ? revealFromRoundResult(roundResult, active) : null;
  const records = winner ? applyRoundRecords(state.records, active, roundResult, winner) : state.records;

  const cards = { ...state.cards };
  if (winner) {
    Object.keys(cards).forEach((id) => delete cards[id]);
  } else {
    delete cards[eliminatedPlayerId];
  }

  const voteResult: VoteResult = {
    round: state.round,
    voteCounts,
    eliminatedPlayerId,
    eliminatedPlayerName: nameOf(eliminatedPlayerId),
    tie,
    winner,
    reveal,
  };

  return {
    state: {
      ...state,
      // 未结算时直接回到本局（结果页由各玩家本地关闭），已结算才进结果页。
      phase: winner ? "REVEALED" : "PLAYING",
      cards,
      votes: {},
      voteReadyPlayerIds: [],
      voteResult,
      winner,
      roundResult,
      records,
      eliminatedPlayerIds: [...state.eliminatedPlayerIds, eliminatedPlayerId],
      nextRoundReadyPlayerIds: [],
    },
    eliminatedPlayerId,
  };
}

export function applyNextRoundReady(
  state: UndercoverState,
  players: readonly Player[],
  playerId: string,
  ready: boolean,
  randomNumber: () => number = Math.random,
): { state: UndercoverState; started: boolean } {
  // 游戏结束后全员点击“准备下一局”也会直接发下一局，不再回大厅。
  if (state.phase !== "REVEALED") {
    return { state, started: false };
  }
  const nextRoundReadyPlayerIds = updatePlayerResponse(state.nextRoundReadyPlayerIds, playerId, ready);
  const nextState: UndercoverState = { ...state, nextRoundReadyPlayerIds };
  // 准备进入下一局需要所有玩家确认（包括本局已淘汰的玩家和下一局加入的新人）。
  const participants = players;
  if (!allPlayersResponded(participants, nextRoundReadyPlayerIds)) {
    return { state: { ...nextState, nextRoundBlocked: false }, started: false };
  }
  // 人数不足最低要求时不允许进入下一局，等新玩家加入后再继续。
  if (players.length < UNDERCOVER_MIN_PLAYERS) {
    return { state: { ...nextState, nextRoundBlocked: true }, started: false };
  }
  // 下一局给包括“下一局才加入”的新人在内的所有玩家发牌。
  const result = startUndercoverRound(nextState, players, randomNumber);
  return { state: result.state, started: true };
}

/** 卧底人数上限：必须严格小于总人数的一半（例如 4 人最多 1 名卧底）。 */
export function maxUndercoverForPlayers(playerCount: number) {
  return Math.max(1, Math.min(3, Math.ceil(playerCount / 2) - 1));
}

export function sanitizeUndercoverSettings(
  value: Partial<UndercoverSettings> | undefined,
  fallback: UndercoverSettings,
  playerCount: number,
): UndercoverSettings {
  const current = fallback;
  return {
    undercover: clampNumber(value?.undercover, 1, maxUndercoverForPlayers(playerCount), current.undercover),
    blank: clampNumber(value?.blank, 0, 1, current.blank),
    scopes: sanitizeWordBankScopes(value?.scopes, current.scopes),
  };
}

/** 只保留合法且不重复的词库范围；结果为空时回退到当前选择。 */
function sanitizeWordBankScopes(value: unknown, fallback: readonly WordBankScope[]): WordBankScope[] {
  const scopes = Array.isArray(value)
    ? value.filter((scope): scope is WordBankScope => scope === 1 || scope === 2 || scope === 3)
    : [];
  const unique = [...new Set(scopes)];
  if (unique.length > 0) return unique;
  const fallbackUnique = [...new Set(fallback)];
  return fallbackUnique.length > 0 ? fallbackUnique : [1];
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 玩家被移出后（踢出/离开）自动推进：
 * - 被移出的是本局卧底 -> 立即平民胜利（主动离开或被踢，断线不算）；
 * - 被移出的是平民/白板且场上只剩两人 -> 卧底胜利；
 * - 否则按阶段继续（开始投票、结算投票或进入下一局）。
 * 若在投票阶段自动结算出淘汰者，通过 eliminatedPlayerId 交由房间层移除。
 */
export function settleUndercoverRemoval(
  state: UndercoverState,
  players: readonly Player[],
  randomNumber: () => number = Math.random,
  removedPlayer?: Player | null,
): { state: UndercoverState; started: boolean; eliminatedPlayerId: string } {
  // 先处理“被移出玩家”引起的即时胜负，再走常规推进。
  if (removedPlayer) {
    const removedCard = state.cards[removedPlayer.id];
    if (removedCard) {
      const active = activePlayers(players, state);
      // 白板必然是卧底：白板卡同样按卧底结算胜负。
      const removedIsUndercover = state.lastWordPair !== null
        && (removedCard.isBlank || removedCard.word === state.lastWordPair.undercover);
      if (removedIsUndercover || active.length <= 2) {
        const winner: Winner = removedIsUndercover ? "civilians" : "undercover";
        const roundPlayers = [...active, removedPlayer];
        const roundResult = buildRoundResult(state, roundPlayers);
        const reveal = roundResult ? revealFromRoundResult(roundResult, roundPlayers) : null;
        const records = applyRoundRecords(state.records, roundPlayers, roundResult, winner);
        const voteResult: VoteResult = {
          round: state.round,
          voteCounts: [],
          eliminatedPlayerId: removedPlayer.id,
          eliminatedPlayerName: removedPlayer.name,
          tie: false,
          winner,
          reveal,
        };
        return {
          state: {
            ...state,
            phase: "REVEALED",
            cards: {},
            votes: {},
            voteReadyPlayerIds: [],
            voteResult,
            winner,
            roundResult,
            records,
            nextRoundReadyPlayerIds: [],
            nextRoundBlocked: false,
          },
          started: false,
          eliminatedPlayerId: "",
        };
      }
    }
  }
  const playerIds = new Set(players.map((player) => player.id));
  const active = activePlayers(players, state);
  const clean: UndercoverState = {
    ...state,
    eliminatedPlayerIds: state.eliminatedPlayerIds.filter((id) => playerIds.has(id)),
    cards: Object.fromEntries(Object.entries(state.cards).filter(([id]) => playerIds.has(id))),
    voteReadyPlayerIds: state.voteReadyPlayerIds.filter((id) => playerIds.has(id)),
    votes: Object.fromEntries(Object.entries(state.votes).filter(([voter]) => playerIds.has(voter))),
    nextRoundReadyPlayerIds: state.nextRoundReadyPlayerIds.filter((id) => playerIds.has(id)),
  };
  if (clean.phase === "PLAYING") {
    if (allPlayersResponded(active, clean.voteReadyPlayerIds)) {
      return { state: { ...clean, phase: "VOTING", votes: {}, voteReadyPlayerIds: [] }, started: false, eliminatedPlayerId: "" };
    }
    return { state: clean, started: false, eliminatedPlayerId: "" };
  }
  if (clean.phase === "VOTING") {
    if (allPlayersResponded(active, Object.keys(clean.votes))) {
      const resolved = resolveVoting(clean, active, randomNumber);
      return { state: resolved.state, started: false, eliminatedPlayerId: resolved.eliminatedPlayerId };
    }
    return { state: clean, started: false, eliminatedPlayerId: "" };
  }
  if (clean.phase === "REVEALED") {
    // 游戏已结束时也要继续检查“准备下一局”：踢出/离开未确认玩家后，
    // 若剩余玩家已全员确认，应立即开始下一局（而不是被 winner 提前返回卡住）。
    if (!clean.winner && active.length < 3) {
      // 踢出/离开导致场上不足三人：按“只剩两人”规则结束。
      const roundResult = buildRoundResult(clean, active);
      const winner = computeWinner(roundResult, active) ?? "civilians";
      const reveal = roundResult ? revealFromRoundResult(roundResult, active) : null;
      const records = applyRoundRecords(clean.records, active, roundResult, winner);
      const voteResult = clean.voteResult
        ? { ...clean.voteResult, winner, reveal }
        : null;
      return {
        state: { ...clean, winner, roundResult, records, voteResult, nextRoundBlocked: false },
        started: false,
        eliminatedPlayerId: "",
      };
    }
    if (allPlayersResponded(players, clean.nextRoundReadyPlayerIds)) {
      // 人数不足最低要求时不允许自动进入下一局。
      if (players.length < UNDERCOVER_MIN_PLAYERS) {
        return { state: { ...clean, nextRoundBlocked: true }, started: false, eliminatedPlayerId: "" };
      }
      const result = startUndercoverRound(clean, players, randomNumber);
      return { state: result.state, started: true, eliminatedPlayerId: "" };
    }
    return { state: { ...clean, nextRoundBlocked: false }, started: false, eliminatedPlayerId: "" };
  }
  return { state: clean, started: false, eliminatedPlayerId: "" };
}
