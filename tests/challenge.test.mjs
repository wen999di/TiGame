import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChallengePenalize,
  applyChallengeReward,
  applyChallengeSwap,
  createChallengeState,
  dismissChallengeLostCard,
  projectChallengeForViewer,
  publicChallengeState,
  restartChallenge,
  settleChallengeRemoval,
  startChallengeRound,
  CHALLENGE_ACTIONS,
  CHALLENGE_MAX_LIVES,
  sanitizeChallengeSettings,
} from "../app/game/challenge.ts";

const PLAYERS = [
  { id: "a", name: "甲", color: "coral", online: true },
  { id: "b", name: "乙", color: "sage", online: true },
  { id: "c", name: "丙", color: "gold", online: true },
];

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `玩家${index}`,
    color: "sage",
    online: true,
  }));
}

test("deals exactly one distinct current card per player with the configured lives", () => {
  const state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  assert.equal(state.phase, "PLAYING");
  assert.equal(state.winnerId, null);
  assert.equal(state.eliminatedPlayerIds.length, 0);
  const current = Object.values(state.currentCards).filter(Boolean);
  assert.equal(new Set(current).size, 3);
  assert.deepEqual(state.lives, { a: 3, b: 3, c: 3 });
  // 不再预发玩家数 × 生命数的完整牌堆（N003）。
  assert.equal("queuedCards" in state, false);
});

test("the public projection hides the viewer's own card", () => {
  const state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  const pub = projectChallengeForViewer(state, "b");
  assert.equal(pub.visibleCards.b, null);
  assert.ok(typeof pub.visibleCards.a === "string");
  assert.ok(typeof pub.visibleCards.c === "string");
  assert.equal("cards" in pub, false);
  assert.equal("queuedCards" in pub, false);
  assert.equal("roundLives" in pub, false);
  assert.equal("lostCardReveal" in pub, false);
  assert.equal("pendingReveals" in pub, false);
  assert.equal("drawPile" in pub, false);
  assert.equal("discardPile" in pub, false);
});

test("anonymous projection hides every player's current card (N004)", () => {
  const state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  const pub = publicChallengeState(state, null);
  assert.deepEqual(Object.values(pub.visibleCards), [null, null, null]);
});

test("legal player/lives combinations never exhaust the card pool (N003)", () => {
  for (const [playerCount, lives] of [[5, 30], [8, 20], [16, 10], [16, 30], [2, 1]]) {
    const players = makePlayers(playerCount);
    let state = startChallengeRound(createChallengeState({ lives }), players, () => 0.37).state;
    // 反复惩罚/奖励/换牌也不得抛异常。
    for (let round = 0; round < 200; round += 1) {
      const target = players[round % players.length].id;
      const penalized = applyChallengePenalize(state, players, players[(round + 1) % players.length].id, target, () => 0.61);
      state = penalized.state;
      if (state.phase !== "PLAYING") break;
      const swapped = applyChallengeSwap(state, players, target, () => 0.83);
      state = swapped.state;
      const rewarded = applyChallengeReward(state, players, target, () => 0.11);
      state = rewarded.state;
    }
  }
  assert.ok(true);
});

test("penalizing reduces a life and draws the next card lazily", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  const first = state.currentCards.a;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  assert.equal(state.lives.a, 2);
  // 还有命：懒抽一张新当前牌（不与任何持有牌重复）。
  const held = new Set(Object.values(state.currentCards).filter(Boolean));
  assert.equal(held.has(state.currentCards.a), true);
  assert.notEqual(state.currentCards.a, first);
  assert.ok(state.discardPile.includes(first));
  // 生命耗尽后淘汰，不再抽牌。
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  assert.equal(state.lives.a, 0);
  assert.equal(state.currentCards.a, null);
  assert.deepEqual(state.eliminatedPlayerIds, ["a"]);
});

test("the last player standing wins", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a").state;
  state = applyChallengePenalize(state, PLAYERS, "a", "b").state;
  assert.equal(state.eliminatedPlayerIds.length, 2);
  assert.equal(state.phase, "ENDED");
  assert.equal(state.winnerId, "c");
});

test("penalizing reveals the discarded card privately to the target player with a stable event id", () => {
  let state = startChallengeRound(createChallengeState({ lives: 2 }), PLAYERS, () => 0).state;
  const lostAction = state.currentCards.a;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  assert.equal(state.pendingReveals.a[0].action, lostAction);
  assert.ok(typeof state.pendingReveals.a[0].eventId === "string" && state.pendingReveals.a[0].eventId.length > 0);
  assert.equal(state.lives.a, 1);
  assert.equal(state.pendingReveals.b, undefined);
});

test("consecutive reveals for different players do not overwrite (B015)", () => {
  let state = startChallengeRound(createChallengeState({ lives: 2 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  const revealA = state.pendingReveals.a[0];
  state = applyChallengePenalize(state, PLAYERS, "a", "c", () => 0.7).state;
  const revealC = state.pendingReveals.c[0];
  assert.ok(revealA && revealC);
  assert.equal(state.pendingReveals.a[0], revealA);
  assert.equal(state.pendingReveals.c[0], revealC);
});

test("consecutive penalties on the same player queue reveals instead of overwriting (P1)", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  const firstEventId = state.pendingReveals.a[0].eventId;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.8).state;
  assert.equal(state.pendingReveals.a.length, 2);
  assert.equal(state.pendingReveals.a[0].eventId, firstEventId);
  assert.notEqual(state.pendingReveals.a[1].eventId, firstEventId);
});

test("dismiss clears one reveal by eventId and keeps the rest", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  state = applyChallengePenalize(state, PLAYERS, "a", "c", () => 0.7).state;
  const eventIdA = state.pendingReveals.a[0].eventId;
  const next = dismissChallengeLostCard(state, "a", eventIdA);
  assert.equal(next.pendingReveals.a, undefined);
  assert.equal(next.pendingReveals.c.length, 1);
  // 同一玩家两条揭示时，按 eventId 只移除对应那条。
  state = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.6).state;
  const firstId = state.pendingReveals.a[0].eventId;
  const secondId = state.pendingReveals.a[1].eventId;
  const afterOne = dismissChallengeLostCard(state, "a", firstId);
  assert.equal(afterOne.pendingReveals.a.length, 1);
  assert.equal(afterOne.pendingReveals.a[0].eventId, secondId);
});

test("removing the revealed player clears their lost card reveal", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a").state;
  assert.ok(state.pendingReveals.a);
  const remaining = PLAYERS.filter((player) => player.id !== "a");
  const settled = settleChallengeRemoval(state, remaining);
  assert.equal(settled.pendingReveals.a, undefined);
});

test("self-penalize applies and eliminated players cannot be penalized again", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  const self = applyChallengePenalize(state, PLAYERS, "a", "a");
  assert.equal(self.state.lives.a, 0);
  assert.deepEqual(self.state.eliminatedPlayerIds, ["a"]);
  const again = applyChallengePenalize(self.state, PLAYERS, "b", "a");
  assert.deepEqual(again.state.eliminatedPlayerIds, ["a"]);
  assert.equal(again.state.lives.a, 0);
});

test("restart re-deals cards and resets lives", () => {
  const state = startChallengeRound(createChallengeState({ lives: 2 }), PLAYERS, () => 0).state;
  const penalized = applyChallengePenalize(state, PLAYERS, "b", "a", () => 0.9).state;
  const restarted = restartChallenge(penalized, PLAYERS, () => 0.5);
  assert.equal(restarted.phase, "PLAYING");
  assert.equal(restarted.winnerId, null);
  assert.deepEqual(restarted.eliminatedPlayerIds, []);
  assert.deepEqual(restarted.lives, { a: 2, b: 2, c: 2 });
  assert.equal(Object.values(restarted.currentCards).filter(Boolean).length, 3);
  assert.deepEqual(restarted.pendingReveals, {});
});

test("records update when a round ends", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a").state;
  state = applyChallengePenalize(state, PLAYERS, "a", "b").state;
  assert.equal(state.phase, "ENDED");
  assert.equal(state.winnerId, "c");
  assert.equal(state.records.c.wins, 1);
  assert.equal(state.records.c.losses, 0);
  assert.equal(state.records.a.losses, 1);
  assert.equal(state.records.b.losses, 1);
});

test("removing a player cleans their data and recomputes the winner", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  state = applyChallengePenalize(state, PLAYERS, "b", "a").state;
  const remaining = PLAYERS.filter((player) => player.id !== "b");
  const settled = settleChallengeRemoval(state, remaining);
  assert.equal("b" in settled.currentCards, false);
  assert.equal("b" in settled.lives, false);
  assert.deepEqual(settled.eliminatedPlayerIds, ["a"]);
  assert.equal(settled.winnerId, "c");
  assert.equal(settled.phase, "ENDED");
});

test("host swap replaces the current card without changing lives", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  const before = state.currentCards.a;
  state = applyChallengeSwap(state, PLAYERS, "a", () => 0.9).state;
  assert.equal(state.lives.a, 3);
  assert.notEqual(state.currentCards.a, before);
  assert.ok(state.discardPile.includes(before));
});

test("swap never draws a card another player currently holds (B014)", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  const heldBefore = new Set(Object.values(state.currentCards).filter(Boolean));
  for (let seed = 0; seed < 50; seed += 1) {
    const next = applyChallengeSwap(state, PLAYERS, "a", () => seed / 100).state;
    assert.equal(heldBefore.has(next.currentCards.a), false);
    state = next;
  }
});

test("reward discards the current card, draws a new current and adds a life", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  const current = state.currentCards.a;
  state = applyChallengeReward(state, PLAYERS, "a", () => 0.9).state;
  // 丢弃当前展示的牌，抽一张新的作为当前牌展示，另一张对应新增生命（懒抽）。
  assert.notEqual(state.currentCards.a, current);
  assert.ok(state.discardPile.includes(current));
  assert.equal(state.lives.a, 4);
  assert.equal(state.lives.b, 3);
  // 新当前牌不能与任何玩家持有的牌重复（B014）。
  const held = new Set(Object.values(state.currentCards).filter(Boolean));
  assert.equal(held.size, 3);
});

test("reward never draws a card another player currently holds (B014)", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  const heldBefore = new Set(Object.values(state.currentCards).filter(Boolean));
  const next = applyChallengeReward(state, PLAYERS, "a", () => 0.9).state;
  assert.equal(heldBefore.has(next.currentCards.a), false);
});

test("reward cannot exceed the hard life cap (N003)", () => {
  let state = startChallengeRound(createChallengeState({ lives: CHALLENGE_MAX_LIVES }), PLAYERS, () => 0).state;
  const before = state.lives.a;
  const result = applyChallengeReward(state, PLAYERS, "a", () => 0.9);
  assert.equal(result.state, state);
  assert.equal(result.state.lives.a, before);
});

test("changing next-round lives does not affect the current round", () => {
  let state = startChallengeRound(createChallengeState({ lives: 3 }), PLAYERS, () => 0).state;
  state = { ...state, settings: { lives: 5 } };
  assert.equal(state.lives.a, 3);
});

test("lives are capped at the server-side hard limit (B013)", () => {
  const settings = sanitizeChallengeSettings({ lives: 999 }, { lives: 3 });
  assert.equal(settings.lives, CHALLENGE_MAX_LIVES);
});

test("the action bank has enough unique entries for the legal maximum", () => {
  assert.ok(CHALLENGE_ACTIONS.length >= 16);
});
test("refilled pool never contains duplicate actions (P1)", () => {
  let state = startChallengeRound(createChallengeState({ lives: 1 }), PLAYERS, () => 0).state;
  // 构造 drawPile 为空、discardPile 含有已弃牌的场景，强制走补牌逻辑。
  const discarded = ["说“好”", "说“可以”", "说“行”"];
  state = {
    ...state,
    drawPile: [],
    discardPile: discarded,
  };
  const swapped = applyChallengeSwap(state, PLAYERS, "a", () => 0.5).state;
  const allCards = [
    ...swapped.drawPile,
    ...swapped.discardPile,
    ...Object.values(swapped.currentCards).filter(Boolean),
  ];
  assert.equal(new Set(allCards).size, allCards.length, "补牌后的牌池不允许重复");
  // 新当前牌不能是他人当前持有的牌。
  const heldByOthers = new Set(Object.entries(swapped.currentCards).filter(([id]) => id !== "a").map(([, action]) => action));
  assert.equal(heldByOthers.has(swapped.currentCards.a), false);
});
test("long random games keep held cards unique, reveals queued and lives bounded", () => {
  const players = makePlayers(6);
  let state = startChallengeRound(createChallengeState({ lives: 8 }), players, () => 0.37).state;
  for (let step = 0; step < 500; step += 1) {
    const target = players[step % players.length].id;
    const penalizer = players[(step + 1) % players.length].id;
    const penalized = applyChallengePenalize(state, players, penalizer, target, () => ((step * 7) % 100) / 100);
    state = penalized.state;
    const heldCards = Object.values(state.currentCards).filter(Boolean);
    assert.equal(new Set(heldCards).size, heldCards.length, `held cards unique at ${step}`);
    for (const reveals of Object.values(state.pendingReveals)) {
      assert.equal(new Set(reveals.map((item) => item.eventId)).size, reveals.length, `reveal eventIds unique at ${step}`);
    }
    assert.ok(Object.values(state.lives).every((lives) => lives <= CHALLENGE_MAX_LIVES), `lives bounded at ${step}`);
    if (state.phase === "ENDED") {
      state = restartChallenge(state, players, () => 0.29).state;
      continue;
    }
    const swapped = applyChallengeSwap(state, players, target, () => ((step * 11) % 100) / 100);
    state = swapped.state;
    const rewarded = applyChallengeReward(state, players, target, () => ((step * 13) % 100) / 100);
    state = rewarded.state;
    // drawPile 不允许出现重复牌。
    assert.equal(new Set(state.drawPile).size, state.drawPile.length, `draw pile unique at ${step}`);
  }
});