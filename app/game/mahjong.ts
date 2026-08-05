import type { Player } from "./types.ts";

export type MahjongPhase = "PLAYING" | "SETTLING";

export type MahjongHistoryEntry = {
  id: string;
  /** give=普通给分；collect=向所有人收取（待确认后生效）。 */
  kind: "give" | "collect";
  fromPlayerId: string;
  fromPlayerName: string;
  toPlayerId: string;
  toPlayerName: string;
  points: number;
  /** 收取条目：参与支付的人数；普通给分为 1。 */
  count: number;
  /** 收取条目：支付方玩家 id（其余玩家）；普通给分为空。 */
  payerIds: string[];
  /** 收取条目：支付方玩家名；普通给分为空。 */
  payerNames: string[];
  /** 收取条目：全员确认前为 pending，生效后为 confirmed；普通给分恒为 confirmed。 */
  status: "confirmed" | "pending";
  at: number;
};

/** 向所有人收取的待确认请求：发起者（收取方）不需要确认，其余玩家每人确认或否决一次。 */
export type MahjongCollectRequest = {
  id: string;
  operationId: string;
  collectorId: string;
  collectorName: string;
  points: number;
  payerIds: string[];
  payerNames: string[];
  confirmedPlayerIds: string[];
  rejectedBy: string | null;
  createdAt: number;
};

/** 一条最简结算建议：from 向 to 送出 points 分。 */
export type SettlementTransfer = {
  fromPlayerId: string;
  fromPlayerName: string;
  toPlayerId: string;
  toPlayerName: string;
  points: number;
};

export type SettlementPlan = {
  transfers: SettlementTransfer[];
};

/** 本局账本参与者：与“房间在线玩家”分离，离桌但带分的人继续保留债权/债务（B006）。 */
export type LedgerPlayer = {
  id: string;
  name: string;
  /** 是否仍在房间，可否继续成为给分目标；false 表示“已离桌”。 */
  active: boolean;
};

export type MahjongState = {
  phase: MahjongPhase;
  /** 玩家 id -> 当前盈亏分数（正为赢，负为输），总和恒为 0。 */
  scores: Record<string, number>;
  /** 账本参与者（含已离桌但带分的玩家）。 */
  ledgerPlayers: Record<string, LedgerPlayer>;
  /** 给分历史，最新的在最前面；只保留最近 200 条。 */
  history: MahjongHistoryEntry[];
  /** 向所有人收取的待确认请求（全员确认后生效，有人否决则作废）。 */
  pendingCollects: MahjongCollectRequest[];
  /** 已点击“重置”的玩家（全员点击后清空分数）。 */
  resetReadyPlayerIds: string[];
  /** 已点击“结账”的玩家（全员点击后进入结账环节）。 */
  settleReadyPlayerIds: string[];
  /** 结账方案；进入结账环节后生成。 */
  settlement: SettlementPlan | null;
};

export type MahjongPublicState = {
  kind: "mahjong";
  phase: MahjongPhase;
  scores: Record<string, number>;
  ledgerPlayers: Record<string, LedgerPlayer>;
  history: MahjongHistoryEntry[];
  pendingCollects: MahjongCollectRequest[];
  resetReadyPlayerIds: string[];
  settleReadyPlayerIds: string[];
  settlement: SettlementPlan | null;
};

export const MAHJONG_HISTORY_LIMIT = 200;

/**
 * 为每条历史生成全局唯一 id（由服务端在 applyMahjongTransfer 中调用）：
 * 优先 crypto.randomUUID，旧运行时回退到加密随机十六进制，避免同毫秒撞 id。
 */
function newHistoryId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // 继续走兜底。
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 账本不变量：所有参与者（含已离桌）的分数之和必须为 0。 */
export function assertZeroSum(scores: Record<string, number>) {
  const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
  if (total !== 0) throw new Error(`Mahjong ledger invariant broken: ${total}`);
}

/**
 * 兼容旧持久化数据：补齐“向所有人收取”相关字段，
 * 避免旧房间快照缺少 pendingCollects / 历史条目新字段导致客户端崩溃。
 */
export function normalizeMahjongState(state: MahjongState): MahjongState {
  return {
    ...state,
    pendingCollects: state.pendingCollects ?? [],
    history: (state.history ?? []).map((entry) => ({
      ...entry,
      kind: entry.kind ?? "give",
      count: entry.count ?? 1,
      payerIds: entry.payerIds ?? [],
      payerNames: entry.payerNames ?? [],
      status: entry.status ?? "confirmed",
    })),
  };
}

export function publicMahjongState(state: MahjongState): MahjongPublicState {
  return { ...normalizeMahjongState(state), kind: "mahjong" };
}

export function createMahjongState(players: readonly Player[]): MahjongState {
  const ledgerPlayers: Record<string, LedgerPlayer> = {};
  for (const player of players) {
    ledgerPlayers[player.id] = { id: player.id, name: player.name, active: true };
  }
  return {
    phase: "PLAYING",
    scores: Object.fromEntries(players.map((player) => [player.id, 0])),
    ledgerPlayers,
    history: [],
    pendingCollects: [],
    resetReadyPlayerIds: [],
    settleReadyPlayerIds: [],
    settlement: null,
  };
}

/** 对局中途加入的玩家立即上桌：分数从 0 开始。 */
export function addMahjongPlayer(state: MahjongState, player: Player): MahjongState {
  if (state.ledgerPlayers[player.id]) return state;
  return {
    ...state,
    scores: { ...state.scores, [player.id]: 0 },
    ledgerPlayers: {
      ...state.ledgerPlayers,
      [player.id]: { id: player.id, name: player.name, active: true },
    },
  };
}

/** 把分数送给另一位玩家：对方加分，自己扣分，并写入历史。 */
export function applyMahjongTransfer(
  state: MahjongState,
  players: readonly Player[],
  fromId: string,
  toId: string,
  points: number,
): { state: MahjongState; applied: boolean } {
  if (state.phase !== "PLAYING") return { state, applied: false };
  const from = players.find((player) => player.id === fromId);
  const to = players.find((player) => player.id === toId);
  if (!from || !to || fromId === toId) return { state, applied: false };
  // 新转分禁止把已离桌玩家作为目标（也禁止从已离桌玩家转出）。
  if (!state.ledgerPlayers[fromId]?.active || !state.ledgerPlayers[toId]?.active) {
    return { state, applied: false };
  }
  if (!Number.isInteger(points) || points <= 0 || points > 99999) return { state, applied: false };

  const entry: MahjongHistoryEntry = {
    id: newHistoryId(),
    kind: "give",
    fromPlayerId: fromId,
    fromPlayerName: from.name,
    toPlayerId: toId,
    toPlayerName: to.name,
    points,
    count: 1,
    payerIds: [],
    payerNames: [],
    status: "confirmed",
    at: Date.now(),
  };
  const next: MahjongState = {
    ...state,
    scores: {
      ...state.scores,
      [fromId]: (state.scores[fromId] ?? 0) - points,
      [toId]: (state.scores[toId] ?? 0) + points,
    },
    history: [entry, ...state.history].slice(0, MAHJONG_HISTORY_LIMIT),
  };
  assertZeroSum(next.scores);
  return { state: next, applied: true };
}

/**
 * 向所有人收取：创建待确认条目并立即写入历史（status=pending）。
 * 收取对象为其他仍在房间且上桌的玩家；全员确认后生效，有人否决则作废。
 */
export function applyMahjongCollect(
  state: MahjongState,
  players: readonly Player[],
  collectorId: string,
  points: number,
  operationId: string,
): { state: MahjongState; applied: boolean } {
  if (state.phase !== "PLAYING") return { state, applied: false };
  const collector = players.find((player) => player.id === collectorId);
  if (!collector || !state.ledgerPlayers[collectorId]?.active) return { state, applied: false };
  if (!Number.isInteger(points) || points <= 0 || points > 99999) return { state, applied: false };
  const payers = players.filter(
    (player) => player.id !== collectorId && state.ledgerPlayers[player.id]?.active !== false,
  );
  if (payers.length === 0) return { state, applied: false };
  const id = newHistoryId();
  const request: MahjongCollectRequest = {
    id,
    operationId,
    collectorId,
    collectorName: collector.name,
    points,
    payerIds: payers.map((player) => player.id),
    payerNames: payers.map((player) => player.name),
    confirmedPlayerIds: [],
    rejectedBy: null,
    createdAt: Date.now(),
  };
  const entry: MahjongHistoryEntry = {
    id,
    kind: "collect",
    fromPlayerId: collectorId,
    fromPlayerName: collector.name,
    toPlayerId: "",
    toPlayerName: "",
    points,
    count: payers.length,
    payerIds: request.payerIds,
    payerNames: request.payerNames,
    status: "pending",
    at: Date.now(),
  };
  return {
    state: {
      ...state,
      pendingCollects: [request, ...state.pendingCollects],
      history: [entry, ...state.history].slice(0, MAHJONG_HISTORY_LIMIT),
    },
    applied: true,
  };
}

/**
 * 支付方确认/否决一次收取请求：全员确认后立即生效（收取方加分，各支付方扣分），
 * 历史条目改为 confirmed；有人否决则删除待确认条目与历史条目，不计分。
 */
export function applyMahjongCollectVote(
  state: MahjongState,
  players: readonly Player[],
  collectId: string,
  voterId: string,
  approve: boolean,
): { state: MahjongState; applied: boolean } {
  if (state.phase !== "PLAYING") return { state, applied: false };
  const request = state.pendingCollects.find((item) => item.id === collectId);
  if (!request) return { state, applied: false };
  if (voterId === request.collectorId || !request.payerIds.includes(voterId)) return { state, applied: false };
  // 幂等：已经投过票的重复请求视为成功无操作（ACK 丢失后的重试不会报错）。
  if (request.rejectedBy || request.confirmedPlayerIds.includes(voterId)) return { state, applied: true };
  if (!approve) {
    // 否决：整笔作废，不计分。
    return {
      state: {
        ...state,
        pendingCollects: state.pendingCollects.filter((item) => item.id !== collectId),
        history: state.history.filter((entry) => entry.id !== collectId),
      },
      applied: true,
    };
  }
  const confirmedPlayerIds = [...request.confirmedPlayerIds, voterId];
  if (!request.payerIds.every((payerId) => confirmedPlayerIds.includes(payerId))) {
    // 还有人没确认：只更新进度。
    return {
      state: {
        ...state,
        pendingCollects: state.pendingCollects.map((item) =>
          item.id === collectId ? { ...item, confirmedPlayerIds } : item),
      },
      applied: true,
    };
  }
  // 全员确认：生效。收取方 += points * 人数，各支付方 -= points。
  const scores = { ...state.scores };
  scores[request.collectorId] = (scores[request.collectorId] ?? 0) + request.points * request.payerIds.length;
  for (const payerId of request.payerIds) {
    scores[payerId] = (scores[payerId] ?? 0) - request.points;
  }
  const next: MahjongState = {
    ...state,
    scores,
    pendingCollects: state.pendingCollects.filter((item) => item.id !== collectId),
    history: state.history.map((entry) =>
      entry.id === collectId ? { ...entry, status: "confirmed" as const } : entry),
  };
  assertZeroSum(next.scores);
  return { state: next, applied: true };
}

/** 玩家被移出时，作废与其相关的所有待确认收取（发起方或支付方）。 */
export function cancelMahjongCollectsForPlayer(
  state: MahjongState,
  playerId: string,
): MahjongState {
  const involvedIds = new Set(
    state.pendingCollects
      .filter((item) => item.collectorId === playerId || item.payerIds.includes(playerId))
      .map((item) => item.id),
  );
  if (involvedIds.size === 0) return state;
  return {
    ...state,
    pendingCollects: state.pendingCollects.filter((item) => !involvedIds.has(item.id)),
    history: state.history.filter((entry) => !involvedIds.has(entry.id)),
  };
}

function allPlayersResponded(
  players: readonly { id: string }[],
  responsePlayerIds: readonly string[],
) {
  const responses = new Set(responsePlayerIds);
  return players.length > 0 && players.every((player) => responses.has(player.id));
}

/** 结账/重置的参与人：当前房间内的在线账本玩家（已离桌玩家不参与确认）。 */
function activeLedgerPlayers(state: MahjongState, players: readonly Player[]): Array<{ id: string }> {
  return players.filter((player) => state.ledgerPlayers[player.id]?.active !== false);
}

/** 结账/结算方案需要包含已离桌但带分的玩家。 */
function settlementParticipants(state: MahjongState, players: readonly Player[]): Array<{ id: string; name: string }> {
  const inRoom = new Set(players.map((player) => player.id));
  const departed = Object.values(state.ledgerPlayers)
    .filter((player) => !player.active && (state.scores[player.id] ?? 0) !== 0)
    .map((player) => ({ id: player.id, name: player.name }));
  return [...players.map((player) => ({ id: player.id, name: player.name })), ...departed];
}

/** 全员点击“重置”后清空全部分数与历史。 */
export function applyMahjongResetReady(
  state: MahjongState,
  players: readonly Player[],
  playerId: string,
  ready: boolean,
): { state: MahjongState; reset: boolean } {
  // 已有人点击“结账”时，重置确认被锁定（反之亦然），避免两个流程同时进行。
  if (state.settleReadyPlayerIds.length > 0) return { state, reset: false };
  const resetReadyPlayerIds = new Set(state.resetReadyPlayerIds);
  if (ready) resetReadyPlayerIds.add(playerId);
  else resetReadyPlayerIds.delete(playerId);
  const nextReady = [...resetReadyPlayerIds];
  const nextState: MahjongState = { ...state, resetReadyPlayerIds: nextReady };
  if (!allPlayersResponded(activeLedgerPlayers(state, players), nextReady)) {
    return { state: nextState, reset: false };
  }
  assertZeroSum(state.scores);
  return {
    state: {
      ...createMahjongState(players),
      phase: "PLAYING",
    },
    reset: true,
  };
}

/** 全员点击“结账”后进入结账环节并生成最简结算方案。 */
export function applyMahjongSettleReady(
  state: MahjongState,
  players: readonly Player[],
  playerId: string,
  ready: boolean,
): { state: MahjongState; settled: boolean } {
  // 已有人点击“重置”时，结账确认被锁定（反之亦然）。
  if (state.resetReadyPlayerIds.length > 0) return { state, settled: false };
  const settleReadyPlayerIds = new Set(state.settleReadyPlayerIds);
  if (ready) settleReadyPlayerIds.add(playerId);
  else settleReadyPlayerIds.delete(playerId);
  const nextReady = [...settleReadyPlayerIds];
  const nextState: MahjongState = { ...state, settleReadyPlayerIds: nextReady };
  if (!allPlayersResponded(activeLedgerPlayers(state, players), nextReady)) {
    return { state: nextState, settled: false };
  }
  assertZeroSum(state.scores);
  return {
    state: {
      ...nextState,
      phase: "SETTLING",
      settleReadyPlayerIds: [],
      resetReadyPlayerIds: [],
      // 未确认的收取一律作废（未生效不参与结算）。
      pendingCollects: [],
      history: nextState.history.filter((entry) => entry.kind !== "collect" || entry.status !== "pending"),
      settlement: computeSettlement(state.scores, settlementParticipants(state, players)),
    },
    settled: true,
  };
}

/**
 * 根据当前盈亏，用贪心算法算出最简的互相结算方案：
 * 每次让最大的输家（负分最多）向最大的赢家（正分最多）送出两者差额中较小的那份，
 * 直到所有人都结清。转移总次数不超过玩家数减一。
 */
export function computeSettlement(
  scores: Record<string, number>,
  participants: readonly { id: string; name: string }[],
): SettlementPlan {
  const nets = participants.map((player) => ({
    playerId: player.id,
    playerName: player.name,
    net: Math.round(scores[player.id] ?? 0),
  }));
  const transfers: SettlementTransfer[] = [];
  let debtor = nets.find((entry) => entry.net < 0);
  let creditor = nets.find((entry) => entry.net > 0);
  while (debtor && creditor) {
    const amount = Math.min(-debtor.net, creditor.net);
    transfers.push({
      fromPlayerId: debtor.playerId,
      fromPlayerName: debtor.playerName,
      toPlayerId: creditor.playerId,
      toPlayerName: creditor.playerName,
      points: amount,
    });
    debtor.net += amount;
    creditor.net -= amount;
    debtor = nets.find((entry) => entry.net < 0);
    creditor = nets.find((entry) => entry.net > 0);
  }
  return { transfers };
}

/** 清空全部分数与历史，重新开始计分。 */
export function mahjongReset(
  state: MahjongState,
  players: readonly Player[],
): MahjongState {
  return createMahjongState(players);
}

/**
 * 玩家被移出后（踢出/离开）：
 * - 分数为 0：从账本移除；
 * - 分数非 0：标记 active:false（“已离桌”），保留名字、分数与结算身份。
 * 然后重新判断剩余玩家是否已全员确认重置/结账，满足则立即推进（B016）。
 */
export function settleMahjongRemoval(
  state: MahjongState,
  players: readonly Player[],
): MahjongState {
  const inRoomIds = new Set(players.map((player) => player.id));
  // 被移出玩家参与的待确认收取作废（无论发起方还是支付方）。
  for (const ledger of Object.values(state.ledgerPlayers)) {
    if (!inRoomIds.has(ledger.id)) state = cancelMahjongCollectsForPlayer(state, ledger.id);
  }
  const scores = { ...state.scores };
  const ledgerPlayers = { ...state.ledgerPlayers };
  for (const [playerId, ledger] of Object.entries(state.ledgerPlayers)) {
    if (inRoomIds.has(playerId)) continue;
    if ((state.scores[playerId] ?? 0) === 0) {
      delete scores[playerId];
      delete ledgerPlayers[playerId];
    } else {
      ledgerPlayers[playerId] = { ...ledger, active: false };
    }
  }
  // 结账阶段只重算结算方案（含离桌玩家），不重新触发全员确认。
  if (state.phase === "SETTLING") {
    const next: MahjongState = {
      ...state,
      scores,
      ledgerPlayers,
      resetReadyPlayerIds: state.resetReadyPlayerIds.filter((id) => inRoomIds.has(id)),
      settleReadyPlayerIds: state.settleReadyPlayerIds.filter((id) => inRoomIds.has(id)),
      settlement: computeSettlement(scores, settlementParticipants({ ...state, scores, ledgerPlayers }, players)),
    };
    assertZeroSum(scores);
    return next;
  }

  const next: MahjongState = {
    ...state,
    scores,
    ledgerPlayers,
    resetReadyPlayerIds: state.resetReadyPlayerIds.filter((id) => inRoomIds.has(id)),
    settleReadyPlayerIds: state.settleReadyPlayerIds.filter((id) => inRoomIds.has(id)),
  };
  assertZeroSum(scores);
  const active = activeLedgerPlayers(next, players);
  // 移除玩家后自动推进：全员已确认重置 -> 立即清空；全员已确认结账 -> 立即生成方案。
  if (next.settleReadyPlayerIds.length === 0
    && next.resetReadyPlayerIds.length > 0
    && allPlayersResponded(active, next.resetReadyPlayerIds)) {
    return { ...createMahjongState(players), phase: "PLAYING" };
  }
  if (next.resetReadyPlayerIds.length === 0
    && next.settleReadyPlayerIds.length > 0
    && allPlayersResponded(active, next.settleReadyPlayerIds)) {
    return {
      ...next,
      phase: "SETTLING",
      settleReadyPlayerIds: [],
      resetReadyPlayerIds: [],
      settlement: computeSettlement(scores, settlementParticipants(next, players)),
    };
  }
  return next;
}