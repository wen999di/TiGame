import assert from "node:assert/strict";
import test from "node:test";

import {
  addMahjongPlayer,
  applyMahjongCollect,
  applyMahjongCollectVote,
  applyMahjongResetReady,
  applyMahjongSettleReady,
  applyMahjongTransfer,
  assertZeroSum,
  computeSettlement,
  createMahjongState,
  mahjongReset,
  normalizeMahjongState,
  settleMahjongRemoval,
} from "../app/game/mahjong.ts";

const PLAYERS = [
  { id: "a", name: "甲", color: "coral", online: true },
  { id: "b", name: "乙", color: "sage", online: true },
  { id: "c", name: "丙", color: "gold", online: true },
];

function sumScores(scores) {
  return Object.values(scores).reduce((sum, score) => sum + score, 0);
}

test("transfer adds points to the target and deducts from the sender", () => {
  const state = createMahjongState(PLAYERS);
  const result = applyMahjongTransfer(state, PLAYERS, "a", "b", 5);
  assert.equal(result.applied, true);
  assert.equal(result.state.scores.a, -5);
  assert.equal(result.state.scores.b, 5);
  assert.equal(result.state.scores.c, 0);
  assert.equal(result.state.history.length, 1);
  assert.equal(result.state.history[0].fromPlayerId, "a");
  assert.equal(result.state.history[0].toPlayerId, "b");
  assert.equal(result.state.history[0].points, 5);
  assert.equal(sumScores(result.state.scores), 0);
});

test("a mid-game joiner is added to the scoreboard immediately", () => {
  const state = createMahjongState(PLAYERS);
  const next = addMahjongPlayer(state, { id: "d", name: "丁", color: "blue", online: true });
  assert.equal(next.scores.d, 0);
  assert.equal(next.ledgerPlayers.d.active, true);
  assert.equal(next.scores.a, 0);
});

test("invalid transfers are ignored", () => {
  const state = createMahjongState(PLAYERS);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "a", "a", 5).applied, false);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "a", "b", 0).applied, false);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "a", "b", -3).applied, false);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "a", "b", 1.5).applied, false);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "a", "b", 100000).applied, false);
  assert.equal(applyMahjongTransfer(state, PLAYERS, "ghost", "b", 5).applied, false);
  assert.deepEqual(state.scores, { a: 0, b: 0, c: 0 });
  assert.equal(state.history.length, 0);
});

test("history shows the newest entry first", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 1).state;
  state = applyMahjongTransfer(state, PLAYERS, "b", "c", 2).state;
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].fromPlayerId, "b");
  assert.equal(state.history[0].toPlayerId, "c");
  assert.equal(state.scores.a, -1);
  assert.equal(state.scores.b, -1);
  assert.equal(state.scores.c, 2);
});

test("history ids are unique across transfers", () => {
  let state = createMahjongState(PLAYERS);
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    state = applyMahjongTransfer(state, PLAYERS, "a", "b", 1).state;
    const entry = state.history[0];
    assert.ok(entry.id.length >= 16, `history id too short: ${entry.id}`);
    assert.ok(!seen.has(entry.id), `duplicate history id: ${entry.id}`);
    seen.add(entry.id);
  }
});

test("reset clears scores and history", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  const reset = mahjongReset(state, PLAYERS);
  assert.deepEqual(reset.scores, { a: 0, b: 0, c: 0 });
  assert.deepEqual(reset.history, []);
});

test("reset requires every player to confirm", () => {
  const state = createMahjongState(PLAYERS);
  const partial = applyMahjongResetReady(state, PLAYERS, "a", true);
  assert.equal(partial.reset, false);
  assert.deepEqual(partial.state.resetReadyPlayerIds, ["a"]);
  const second = applyMahjongResetReady(partial.state, PLAYERS, "b", true);
  assert.equal(second.reset, false);
  const all = applyMahjongResetReady(second.state, PLAYERS, "c", true);
  assert.equal(all.reset, true);
  assert.deepEqual(all.state.scores, { a: 0, b: 0, c: 0 });
  assert.deepEqual(all.state.history, []);
  assert.deepEqual(all.state.resetReadyPlayerIds, []);
});

test("settling requires every player to confirm and computes the plan", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  state = applyMahjongTransfer(state, PLAYERS, "a", "c", 2).state;
  // a: -7, b: 5, c: 2
  const partial = applyMahjongSettleReady(state, PLAYERS, "a", true);
  assert.equal(partial.settled, false);
  assert.equal(partial.state.phase, "PLAYING");
  const second = applyMahjongSettleReady(partial.state, PLAYERS, "b", true);
  const all = applyMahjongSettleReady(second.state, PLAYERS, "c", true);
  assert.equal(all.settled, true);
  assert.equal(all.state.phase, "SETTLING");
  assert.ok(all.state.settlement);
  assert.deepEqual(
    all.state.settlement.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "b", 5], ["a", "c", 2]],
  );
});

test("computeSettlement finds a minimal transfer plan", () => {
  const plan = computeSettlement({ a: -7, b: 5, c: 2 }, PLAYERS);
  assert.deepEqual(
    plan.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "b", 5], ["a", "c", 2]],
  );
  const multi = computeSettlement({ a: -3, b: -2, c: 5 }, PLAYERS);
  assert.deepEqual(
    multi.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "c", 3], ["b", "c", 2]],
  );
  const zero = computeSettlement({ a: 0, b: 0, c: 0 }, PLAYERS);
  assert.deepEqual(zero.transfers, []);
});

test("transfer is blocked while settling", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongSettleReady(state, PLAYERS, "a", true).state;
  state = applyMahjongSettleReady(state, PLAYERS, "b", true).state;
  state = applyMahjongSettleReady(state, PLAYERS, "c", true).state;
  assert.equal(state.phase, "SETTLING");
  const result = applyMahjongTransfer(state, PLAYERS, "a", "b", 3);
  assert.equal(result.applied, false);
  assert.equal(result.state.history.length, 0);
});

test("removing a player cleans ready lists and recomputes settlement", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  state = applyMahjongSettleReady(state, PLAYERS, "a", true).state;
  state = applyMahjongSettleReady(state, PLAYERS, "b", true).state;
  state = applyMahjongSettleReady(state, PLAYERS, "c", true).state;
  assert.equal(state.phase, "SETTLING");
  state = { ...state, resetReadyPlayerIds: ["a", "b"] };
  const remaining = PLAYERS.filter((player) => player.id !== "c");
  const settled = settleMahjongRemoval(state, remaining);
  assert.deepEqual(settled.resetReadyPlayerIds, ["a", "b"]);
  assert.ok(settled.settlement);
  assert.deepEqual(
    settled.settlement.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "b", 5]],
  );
});

test("a departed player with non-zero score stays in the ledger as inactive (B006)", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  // a: -5, b: 5, c: 0；c 离开（0 分移除），b 离开（带分保留为已离桌）
  const remaining = PLAYERS.filter((player) => player.id !== "b" && player.id !== "c");
  const settled = settleMahjongRemoval(state, remaining);
  assert.equal("c" in settled.scores, false);
  assert.equal("c" in settled.ledgerPlayers, false);
  assert.equal(settled.ledgerPlayers.b.active, false);
  assert.equal(settled.scores.b, 5);
  // 剩余在线玩家（a）与已离桌玩家（b）的分数之和仍为 0。
  assert.equal(sumScores(settled.scores), 0);
  // 结算仍包含已离桌玩家的债权/债务。
  const plan = computeSettlement(settled.scores, [...remaining, { id: "b", name: "乙" }]);
  assert.deepEqual(
    plan.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "b", 5]],
  );
});

test("transfers to a departed player are blocked (B006)", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  const remaining = PLAYERS.filter((player) => player.id !== "b");
  const settled = settleMahjongRemoval(state, remaining);
  const blocked = applyMahjongTransfer(settled, remaining, "a", "b", 2);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.state.scores.a, -5);
});

test("removing the last unconfirmed player advances reset automatically (B016)", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  // a、b 已确认重置，c 未确认；把 c 移出后应立即完成重置。
  state = applyMahjongResetReady(state, PLAYERS, "a", true).state;
  state = applyMahjongResetReady(state, PLAYERS, "b", true).state;
  const remaining = PLAYERS.filter((player) => player.id !== "c");
  const settled = settleMahjongRemoval(state, remaining);
  assert.equal(settled.phase, "PLAYING");
  assert.deepEqual(settled.scores, { a: 0, b: 0 });
  assert.deepEqual(settled.history, []);
});

test("removing the last unconfirmed player advances settle automatically (B016)", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  state = applyMahjongSettleReady(state, PLAYERS, "a", true).state;
  state = applyMahjongSettleReady(state, PLAYERS, "b", true).state;
  const remaining = PLAYERS.filter((player) => player.id !== "c");
  const settled = settleMahjongRemoval(state, remaining);
  assert.equal(settled.phase, "SETTLING");
  assert.ok(settled.settlement);
  assert.deepEqual(
    settled.settlement.transfers.map((t) => [t.fromPlayerId, t.toPlayerId, t.points]),
    [["a", "b", 5]],
  );
});

test("zero-sum invariant holds after every transfer", () => {
  let state = createMahjongState(PLAYERS);
  for (let i = 1; i <= 20; i += 1) {
    const from = PLAYERS[i % 3].id;
    const to = PLAYERS[(i + 1) % 3].id;
    state = applyMahjongTransfer(state, PLAYERS, from, to, i).state;
    assert.equal(sumScores(state.scores), 0);
  }
  assert.doesNotThrow(() => assertZeroSum(state.scores));
});

test("reset and settle confirmations are mutually exclusive", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongSettleReady(state, PLAYERS, "a", true).state;
  const blockedReset = applyMahjongResetReady(state, PLAYERS, "b", true);
  assert.equal(blockedReset.reset, false);
  assert.deepEqual(blockedReset.state.resetReadyPlayerIds, []);

  state = createMahjongState(PLAYERS);
  state = applyMahjongResetReady(state, PLAYERS, "a", true).state;
  const blockedSettle = applyMahjongSettleReady(state, PLAYERS, "b", true);
  assert.equal(blockedSettle.settled, false);
  assert.deepEqual(blockedSettle.state.settleReadyPlayerIds, []);
});
test("collect creates a pending entry visible in history and does not score yet", () => {
  let state = createMahjongState(PLAYERS);
  const result = applyMahjongCollect(state, PLAYERS, "a", 10, "collect-op-1");
  assert.equal(result.applied, true);
  state = result.state;
  assert.equal(state.pendingCollects.length, 1);
  assert.equal(state.pendingCollects[0].collectorId, "a");
  assert.deepEqual(state.pendingCollects[0].payerIds, ["b", "c"]);
  assert.equal(state.history[0].kind, "collect");
  assert.equal(state.history[0].status, "pending");
  assert.equal(state.history[0].count, 2);
  assert.equal(state.history[0].points, 10);
  assert.deepEqual(state.scores, { a: 0, b: 0, c: 0 });
});

test("collect takes effect only after every payer confirms", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongCollect(state, PLAYERS, "a", 10, "collect-op-2").state;
  const collectId = state.pendingCollects[0].id;
  const first = applyMahjongCollectVote(state, PLAYERS, collectId, "b", true);
  assert.equal(first.applied, true);
  state = first.state;
  assert.equal(state.pendingCollects.length, 1);
  assert.deepEqual(state.pendingCollects[0].confirmedPlayerIds, ["b"]);
  assert.equal(state.history[0].status, "pending");
  assert.deepEqual(state.scores, { a: 0, b: 0, c: 0 });
  const second = applyMahjongCollectVote(state, PLAYERS, collectId, "c", true);
  assert.equal(second.applied, true);
  state = second.state;
  assert.equal(state.pendingCollects.length, 0);
  assert.equal(state.history[0].status, "confirmed");
  assert.deepEqual(state.scores, { a: 20, b: -10, c: -10 });
});

test("collect is discarded when any payer rejects", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongCollect(state, PLAYERS, "a", 10, "collect-op-3").state;
  const collectId = state.pendingCollects[0].id;
  const result = applyMahjongCollectVote(state, PLAYERS, collectId, "b", false);
  assert.equal(result.applied, true);
  state = result.state;
  assert.equal(state.pendingCollects.length, 0);
  assert.equal(state.history.length, 0);
  assert.deepEqual(state.scores, { a: 0, b: 0, c: 0 });
});

test("collect votes are idempotent and restricted to payers", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongCollect(state, PLAYERS, "a", 10, "collect-op-4").state;
  const collectId = state.pendingCollects[0].id;
  // 收取方不能投票；重复确认视为成功无操作。
  assert.equal(applyMahjongCollectVote(state, PLAYERS, collectId, "a", true).applied, false);
  state = applyMahjongCollectVote(state, PLAYERS, collectId, "b", true).state;
  const repeat = applyMahjongCollectVote(state, PLAYERS, collectId, "b", true);
  assert.equal(repeat.applied, true);
  assert.equal(repeat.state.pendingCollects[0].confirmedPlayerIds.length, 1);
});

test("removing a player cancels pending collects they participate in", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongCollect(state, PLAYERS, "a", 10, "collect-op-5").state;
  // 移出支付方 b：整笔作废，历史里不再出现待确认条目。
  state = settleMahjongRemoval(state, PLAYERS.filter((player) => player.id !== "b"));
  assert.equal(state.pendingCollects.length, 0);
  assert.equal(state.history.length, 0);
  assert.deepEqual(state.scores, { a: 0, c: 0 });
});
test("normalizeMahjongState fills defaults for legacy room snapshots", () => {
  let state = createMahjongState(PLAYERS);
  state = applyMahjongTransfer(state, PLAYERS, "a", "b", 5).state;
  // 模拟旧版持久化：去掉新增字段。
  const legacy = {
    ...state,
    pendingCollects: undefined,
    history: state.history.map((entry) => {
      const copy = { ...entry };
      delete copy.kind;
      delete copy.count;
      delete copy.payerIds;
      delete copy.payerNames;
      delete copy.status;
      return copy;
    }),
  };
  const normalized = normalizeMahjongState(legacy);
  assert.deepEqual(normalized.pendingCollects, []);
  assert.equal(normalized.history[0].kind, "give");
  assert.equal(normalized.history[0].count, 1);
  assert.equal(normalized.history[0].status, "confirmed");
});
