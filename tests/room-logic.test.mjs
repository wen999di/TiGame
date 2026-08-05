import assert from "node:assert/strict";
import test from "node:test";

import {
  allPlayersResponded,
  applyNextRoundReady,
  applyVote,
  applyVoteReady,
  createUndercoverState,
  maxUndercoverForPlayers,
  resolveVoting,
  settleUndercoverRemoval,
  startUndercoverRound,
  updatePlayerResponse,
} from "../app/game/undercover.ts";
import { approveJoinRequest, backToLobby, createRoomState, enterGame, hostReturnToGame, hostToLobby, publicRoom, settleAfterRemoval } from "../app/game/room.ts";
import { normalizeRoomId } from "../app/game/room-id.ts";

function players(ids, onlineIds) {
  const all = {
    host: { id: "host", name: "房主", color: "coral" },
    "player-one": { id: "player-one", name: "玩家一", color: "sage" },
    "player-two": { id: "player-two", name: "玩家二", color: "gold" },
    p1: { id: "p1", name: "玩家一", color: "sage" },
    p2: { id: "p2", name: "玩家二", color: "gold" },
    p3: { id: "p3", name: "玩家三", color: "blue" },
  };
  return ids.map((id) => ({ ...all[id], online: onlineIds ? onlineIds.includes(id) : true }));
}

function threePlayers(onlineIds = ["host", "player-one", "player-two"]) {
  return players(["host", "player-one", "player-two"], onlineIds);
}

function fourPlayers(onlineIds = ["host", "p1", "p2", "p3"]) {
  return players(["host", "p1", "p2", "p3"], onlineIds);
}

function startRoundWith(roomPlayers) {
  const state = createUndercoverState({ undercover: 1, blank: 0, scopes: [1] });
  return startUndercoverRound(state, roomPlayers, () => 0);
}

function startVoting(roundState, roomPlayers, ids) {
  let current = roundState;
  for (const id of ids) {
    current = applyVoteReady(current, roomPlayers, id, true).state;
  }
  return current;
}

function castAll(current, roomPlayers, votes) {
  for (const [voter, target] of Object.entries(votes)) {
    current = applyVote(current, roomPlayers, voter, target).state;
  }
  return current;
}

test("waits for every player, including offline ones, before advancing", () => {
  const roomPlayers = threePlayers(["host", "player-one"]);
  const hostResponse = updatePlayerResponse([], "host", true);
  const allResponses = updatePlayerResponse(hostResponse, "player-one", true);

  assert.equal(allPlayersResponded(roomPlayers, hostResponse), false);
  assert.equal(allPlayersResponded(roomPlayers, allResponses), false);
  assert.equal(allPlayersResponded(roomPlayers, updatePlayerResponse(allResponses, "player-two", true)), true);
});

test("deals cards to offline players too when a round starts", () => {
  const roomPlayers = threePlayers(["host", "player-one"]);
  const result = startRoundWith(roomPlayers);

  assert.equal(result.state.phase, "PLAYING");
  assert.equal(result.state.round, 1);
  assert.deepEqual(
    Object.keys(result.cards).sort(),
    ["host", "player-one", "player-two"],
  );
  assert.equal(result.cards["player-two"].round, 1);
});

test("vote-ready waits for every player, including offline ones, before voting starts", () => {
  const roomPlayers = threePlayers(["host", "player-one"]);
  const round = startRoundWith(roomPlayers);
  const withHost = applyVoteReady(round.state, roomPlayers, "host", true);
  const withTwo = applyVoteReady(withHost.state, roomPlayers, "player-one", true);

  assert.equal(withTwo.started, false);
  assert.equal(withTwo.state.phase, "PLAYING");

  const allReady = applyVoteReady(withTwo.state, roomPlayers, "player-two", true);
  assert.equal(allReady.started, true);
  assert.equal(allReady.state.phase, "VOTING");
  assert.deepEqual(allReady.state.votes, {});
});

test("votes stay private until everyone has voted, then resolve", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  assert.equal(voting.phase, "VOTING");

  const first = applyVote(voting, roomPlayers, "host", "player-one");
  assert.equal(first.done, false);
  assert.equal(first.state.phase, "VOTING");

  const second = applyVote(first.state, roomPlayers, "player-one", "host");
  assert.equal(second.done, false);

  const third = applyVote(second.state, roomPlayers, "player-two", "host");
  assert.equal(third.done, true);

  const resolved = resolveVoting(third.state, roomPlayers, () => 0);
  assert.equal(resolved.state.phase, "REVEALED");
  assert.ok(resolved.state.voteResult);
  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "host");
  assert.deepEqual(resolved.state.votes, {});
  // host 不是卧底（卧底是 player-one），剩 2 人 -> 卧底胜利
  assert.equal(resolved.state.voteResult.winner, "undercover");
});

test("eliminating the undercover ends the game with a civilian win", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-one",
    "player-one": "player-two",
    "player-two": "player-one",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);

  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "player-one");
  assert.equal(resolved.state.voteResult.winner, "civilians");
  assert.ok(resolved.state.voteResult.reveal);
  assert.deepEqual(
    resolved.state.voteResult.reveal.undercoverPlayers.map((player) => player.playerId),
    ["player-one"],
  );
  assert.deepEqual(resolved.state.cards, {});
});

test("eliminating a civilian with more than two players left shows results and continues the same round", () => {
  const roomPlayers = fourPlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  const current = castAll(voting, roomPlayers, { host: "p2", p1: "p2", p2: "p3", p3: "p2" });
  const resolved = resolveVoting(current, roomPlayers, () => 0);

  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "p2");
  assert.equal(resolved.state.voteResult.winner, null);
  assert.equal(resolved.state.voteResult.reveal, null);
  // 未结算时直接回到本局继续（结果页由各玩家本地展示与关闭）。
  assert.equal(resolved.state.phase, "PLAYING");
  assert.equal(resolved.state.round, 1);
  assert.deepEqual(resolved.state.eliminatedPlayerIds, ["p2"]);

  // 被淘汰者观战，剩余玩家可以重新进入投票。
  const reVoting = startVoting(resolved.state, roomPlayers, ["host", "p1", "p3"]);
  assert.equal(reVoting.phase, "VOTING");
});

test("reaching two players without eliminating the undercover is an undercover win", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-two",
    "player-one": "host",
    "player-two": "host",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);

  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "host");
  // 卧底 player-one 未被投出且场上只剩两人 -> 卧底胜利
  assert.equal(resolved.state.voteResult.winner, "undercover");
  assert.ok(resolved.state.voteResult.reveal);
});

test("a tie does not eliminate anyone and returns to vote-ready", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-one",
    "player-one": "player-two",
    "player-two": "host",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);

  assert.equal(resolved.state.voteResult.tie, true);
  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "");
  assert.equal(resolved.eliminatedPlayerId, "");
  assert.equal(resolved.state.phase, "PLAYING");
  assert.deepEqual(resolved.state.votes, {});
  assert.deepEqual(resolved.state.voteReadyPlayerIds, []);

  // 平票后重新“准备投票”可以再次进入投票环节
  let reReady = resolved.state;
  for (const id of ["host", "player-one", "player-two"]) {
    reReady = applyVoteReady(reReady, roomPlayers, id, true).state;
  }
  assert.equal(reReady.phase, "VOTING");
});

test("vote-eliminated players stay out for the rest of the round", () => {
  const roomPlayers = fourPlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  const current = castAll(voting, roomPlayers, { host: "p2", p1: "p2", p2: "p3", p3: "p2" });
  const resolved = resolveVoting(current, roomPlayers, () => 0);

  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "p2");
  assert.deepEqual(resolved.state.eliminatedPlayerIds, ["p2"]);
  assert.equal(resolved.state.phase, "PLAYING");
  assert.equal(resolved.state.voteResult.winner, null);

  // 有人再次“准备投票”时清空上一轮投票结果，避免结果页重复弹出。
  const ready = applyVoteReady(resolved.state, roomPlayers, "host", true).state;
  assert.equal(ready.voteResult, null);

  // 被淘汰者不能提交“准备投票”，下一轮只包含剩余玩家。
  const blocked = applyVoteReady(resolved.state, roomPlayers, "p2", true);
  assert.equal(blocked.state.voteReadyPlayerIds.length, 0);
  const reVoting = startVoting(resolved.state, roomPlayers, ["host", "p1", "p3"]);
  assert.equal(reVoting.phase, "VOTING");
  assert.deepEqual(Object.keys(reVoting.votes), []);
});

test("self-votes are ignored", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);

  const selfVote = applyVote(voting, roomPlayers, "host", "host");
  assert.equal(selfVote.done, false);
  assert.deepEqual(selfVote.state.votes, {});

  const realVote = applyVote(selfVote.state, roomPlayers, "host", "player-one");
  assert.deepEqual(realVote.state.votes, { host: "player-one" });
});

test("kicking the last unconfirmed offline player starts voting automatically", () => {
  const roomPlayers = threePlayers(["host", "player-one"]);
  const round = startRoundWith(roomPlayers);
  const withHost = applyVoteReady(round.state, roomPlayers, "host", true);
  const withTwo = applyVoteReady(withHost.state, roomPlayers, "player-one", true);

  const remaining = roomPlayers.filter((player) => player.id !== "player-two");
  const settled = settleUndercoverRemoval(withTwo.state, remaining, () => 0);

  assert.equal(settled.state.phase, "VOTING");
  assert.equal(settled.state.voteReadyPlayerIds.includes("player-two"), false);
});

test("kicking during voting can settle automatically", () => {
  const roomPlayers = fourPlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  let current = applyVote(voting, roomPlayers, "host", "p2").state;
  current = applyVote(current, roomPlayers, "p1", "p2").state;
  current = applyVote(current, roomPlayers, "p2", "p3").state;

  const remaining = roomPlayers.filter((player) => player.id !== "p3");
  const settled = settleUndercoverRemoval(current, remaining, () => 0);

  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.voteResult.eliminatedPlayerId, "p2");
  assert.equal(settled.eliminatedPlayerId, "p2");
  // 卧底 p1 未出局，剩 2 人 -> 卧底胜利
  assert.equal(settled.state.voteResult.winner, "undercover");
});

test("kicking below three players after a continuing elimination ends the game", () => {
  const roomPlayers = fourPlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  const current = castAll(voting, roomPlayers, { host: "p2", p1: "p2", p2: "p3", p3: "p2" });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  assert.equal(resolved.state.voteResult.winner, null);
  assert.equal(resolved.state.phase, "PLAYING");

  // 未结算已回到本局，再踢出一名玩家，使场上只剩 2 人 -> 卧底胜利。
  const remaining = roomPlayers.filter((player) => player.id !== "p2" && player.id !== "p3");
  const removed = roomPlayers.find((player) => player.id === "p3");
  const settled = settleUndercoverRemoval(resolved.state, remaining, () => 0, removed);

  assert.equal(settled.state.phase, "REVEALED");
  // 卧底 p1 仍在场上，剩 2 人 -> 卧底胜利
  assert.equal(settled.state.winner, "undercover");
});

test("next round can start after the game is over", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-one",
    "player-one": "player-two",
    "player-two": "player-one",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  assert.equal(resolved.state.voteResult.winner, "civilians");

  // 游戏结束后全员（含被淘汰的卧底）“准备下一局”直接开始下一局
  let next = resolved.state;
  for (const id of ["host", "player-two"]) {
    next = applyNextRoundReady(next, roomPlayers, id, true, () => 0).state;
  }
  assert.equal(next.phase, "REVEALED");
  next = applyNextRoundReady(next, roomPlayers, "player-one", true, () => 0).state;
  assert.equal(next.phase, "PLAYING");
  assert.equal(next.round, 2);
  assert.equal(next.winner, null);
});

test("records update after a game ends", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-one",
    "player-one": "player-two",
    "player-two": "player-one",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  // 卧底 player-one 出局 -> 平民胜利
  assert.equal(resolved.state.voteResult.winner, "civilians");
  assert.equal(resolved.state.records.host.wins, 1);
  assert.equal(resolved.state.records.host.losses, 0);
  assert.equal(resolved.state.records["player-one"].wins, 0);
  assert.equal(resolved.state.records["player-one"].losses, 1);
  assert.equal(resolved.state.records["player-two"].wins, 1);
});

test("joinNextRound players are excluded from the current round", () => {
  const roomPlayers = [
    ...threePlayers(),
    { id: "newbie", name: "新人", color: "blue", online: true, joinNextRound: true },
  ];
  const round = startRoundWith(roomPlayers);
  // 新人不能提交“准备投票”，提交了也不会被记录
  const newbieReady = applyVoteReady(round.state, roomPlayers, "newbie", true);
  assert.equal(newbieReady.state.voteReadyPlayerIds.length, 0);
  const withHost = applyVoteReady(round.state, roomPlayers, "host", true);
  const withTwo = applyVoteReady(withHost.state, roomPlayers, "player-one", true);
  const withThree = applyVoteReady(withTwo.state, roomPlayers, "player-two", true);
  // 新人不需要操作，三位在局玩家都准备后即进入投票
  assert.equal(withThree.started, true);
  assert.equal(withThree.state.phase, "VOTING");
  // 新人也不能成为投票对象
  const voting = withThree.state;
  const vote = applyVote(voting, roomPlayers, "host", "newbie");
  assert.equal(vote.done, false);
  assert.deepEqual(vote.state.votes, {});
});

test("joinNextRound players must also confirm before the next round starts", () => {
  const roomPlayers = [
    ...threePlayers(),
    { id: "newbie", name: "新人", color: "blue", online: true, joinNextRound: true },
  ];
  let state = createUndercoverState({ undercover: 1, blank: 0, scopes: [1] });
  state = { ...state, phase: "REVEALED" };
  for (const id of ["host", "player-one", "player-two"]) {
    state = applyNextRoundReady(state, roomPlayers, id, true, () => 0).state;
  }
  // 新人还没确认时，下一局不开始
  assert.equal(state.phase, "REVEALED");
  state = applyNextRoundReady(state, roomPlayers, "newbie", true, () => 0).state;
  assert.equal(state.phase, "PLAYING");
});

test("next round does not start below the minimum player count", () => {
  const roomPlayers = threePlayers().slice(0, 2);
  let state = createUndercoverState({ undercover: 1, blank: 0, scopes: [1] });
  state = { ...state, phase: "REVEALED" };
  for (const player of roomPlayers) {
    state = applyNextRoundReady(state, roomPlayers, player.id, true, () => 0).state;
  }
  assert.equal(state.phase, "REVEALED");
  assert.equal(state.nextRoundBlocked, true);
  assert.equal(state.round, 0);
});

test("a room left with fewer than 3 players cannot start the next round", () => {
  // 三人局中途一人离开，剩下两人即使都准备也不能进入下一局。
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const remaining = roomPlayers.filter((player) => player.id !== "player-two");
  const removed = roomPlayers.find((player) => player.id === "player-two");
  const settled = settleUndercoverRemoval(round.state, remaining, () => 0, removed);
  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.winner, "undercover");
  let state = settled.state;
  for (const player of remaining) {
    state = applyNextRoundReady(state, remaining, player.id, true, () => 0).state;
  }
  assert.equal(state.phase, "REVEALED");
  assert.equal(state.nextRoundBlocked, true);
  assert.equal(state.round, 1);
});

test("kicking the undercover ends the round with a civilian win", () => {
  const roomPlayers = fourPlayers(); // 卧底 p1（random 0）
  const round = startRoundWith(roomPlayers);
  const remaining = roomPlayers.filter((player) => player.id !== "p1");
  const removed = roomPlayers.find((player) => player.id === "p1");
  const settled = settleUndercoverRemoval(round.state, remaining, () => 0, removed);
  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.winner, "civilians");
  assert.equal(settled.state.records.host.wins, 1);
  assert.equal(settled.state.records.p1.losses, 1);
  assert.ok(settled.state.voteResult.reveal);
  assert.ok(settled.state.voteResult.reveal.undercoverPlayers.some((p) => p.playerId === "p1"));
});

test("voting out a blank undercover is a civilian win and reveals the blank", () => {
  // 白板开启 + random 0：卧底 p1 同时是白板。
  let state = createUndercoverState({ undercover: 1, blank: 1, scopes: [1] });
  const roomPlayers = fourPlayers();
  const round = startUndercoverRound(state, roomPlayers, () => 0);
  assert.equal(round.state.cards.p1.isBlank, true);

  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  const current = castAll(voting, roomPlayers, { host: "p1", p1: "p2", p2: "p1", p3: "p1" });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  assert.equal(resolved.state.voteResult.eliminatedPlayerId, "p1");
  assert.equal(resolved.state.voteResult.winner, "civilians");
  assert.deepEqual(
    resolved.state.voteResult.reveal.undercoverPlayers.map((p) => p.playerId),
    ["p1"],
  );
  // 白板名单与卧底名单一致：白板必然同时是卧底。
  assert.deepEqual(
    resolved.state.voteResult.reveal.blankPlayers.map((p) => p.playerId),
    ["p1"],
  );
});

test("kicking a blank undercover ends the round with a civilian win", () => {
  // 白板开启 + random 0：卧底 p1 同时是白板。
  let state = createUndercoverState({ undercover: 1, blank: 1, scopes: [1] });
  const roomPlayers = fourPlayers();
  const round = startUndercoverRound(state, roomPlayers, () => 0);
  assert.equal(round.state.cards.p1.isBlank, true);

  const remaining = roomPlayers.filter((player) => player.id !== "p1");
  const removed = roomPlayers.find((player) => player.id === "p1");
  const settled = settleUndercoverRemoval(round.state, remaining, () => 0, removed);
  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.winner, "civilians");
  assert.equal(settled.state.records.p1.losses, 1);
  assert.ok(settled.state.voteResult.reveal);
  assert.ok(settled.state.voteResult.reveal.undercoverPlayers.some((p) => p.playerId === "p1"));
  assert.ok(settled.state.voteResult.reveal.blankPlayers.some((p) => p.playerId === "p1"));
});

test("kicking a civilian down to two players is an undercover win", () => {
  const roomPlayers = threePlayers(); // 卧底 player-one
  const round = startRoundWith(roomPlayers);
  const remaining = roomPlayers.filter((player) => player.id !== "host"); // host 是平民
  const removed = roomPlayers.find((player) => player.id === "host");
  const settled = settleUndercoverRemoval(round.state, remaining, () => 0, removed);
  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.winner, "undercover");
  assert.equal(settled.state.records["player-one"].wins, 1);
});

test("kicking a civilian without reaching the settlement condition continues the game", () => {
  const roomPlayers = fourPlayers(); // 卧底 p1
  const round = startRoundWith(roomPlayers);
  const remaining = roomPlayers.filter((player) => player.id !== "p3"); // p3 是平民
  const removed = roomPlayers.find((player) => player.id === "p3");
  const settled = settleUndercoverRemoval(round.state, remaining, () => 0, removed);
  assert.equal(settled.state.winner, null);
  assert.equal(settled.state.phase, "PLAYING");
  let current = settled.state;
  for (const id of ["host", "p1", "p2"]) {
    current = applyVoteReady(current, remaining, id, true).state;
  }
  assert.equal(current.phase, "VOTING");
});

test("max undercover is strictly less than half the players", () => {
  assert.equal(maxUndercoverForPlayers(3), 1);
  assert.equal(maxUndercoverForPlayers(4), 1);
  assert.equal(maxUndercoverForPlayers(5), 2);
  assert.equal(maxUndercoverForPlayers(6), 2);
  assert.equal(maxUndercoverForPlayers(7), 3);
  assert.equal(maxUndercoverForPlayers(8), 3);
});

test("removal auto-clamps the undercover setting below half the players", () => {
  let state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  state = {
    ...state,
    players: [
      ...state.players,
      { id: "p1", name: "玩家一", color: "sage", online: true },
      { id: "p2", name: "玩家二", color: "gold", online: true },
      { id: "p3", name: "玩家三", color: "blue", online: true },
    ],
  };
  const entered = enterGame(state, "undercover", () => 0);
  entered.state.gameState.settings.undercover = 3;
  const removed = entered.state.players[0];
  const remaining = entered.state.players.filter((player) => player.id !== removed.id);
  const settled = settleAfterRemoval({ ...entered.state, players: remaining }, () => 0, removed);
  // 移出后剩 3 人：卧底必须 < 1.5，最多 1
  assert.equal(settled.state.gameState.settings.undercover, 1);
});

test("approving a join request with a duplicate nickname is rejected", () => {
  let state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  state = {
    ...state,
    pendingJoinRequests: [{ id: "req-1", playerName: "房主", createdAt: Date.now() }],
  };
  const result = approveJoinRequest(state, "req-1", true);
  assert.equal(result.request, null);
  assert.equal(result.state.players.length, 1);
});

test("room-level enterGame/backToLobby and publicRoom privacy", () => {
  let state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  state = {
    ...state,
    players: [
      ...state.players,
      { id: "player-one", name: "玩家一", color: "sage", online: true },
      { id: "player-two", name: "玩家二", color: "gold", online: true },
    ],
  };
  const entered = enterGame(state, "undercover", () => 0);
  assert.equal(entered.state.phase, "GAME");
  assert.equal(entered.state.gameId, "undercover");
  assert.equal(entered.sendCards, false);
  assert.equal(entered.state.gameState.phase, "SETUP");

  const pub = publicRoom(entered.state);
  assert.equal(pub.game.kind, "undercover");
  assert.equal("cards" in pub.game, false);
  assert.equal("votes" in pub.game, false);
  assert.equal("lastWordPair" in pub.game, false);
  assert.ok(Array.isArray(pub.game.votedPlayerIds));

  const lobby = backToLobby(entered.state);
  assert.equal(lobby.phase, "LOBBY");
  assert.equal(lobby.gameId, null);
  assert.equal(lobby.gameState, null);
});

test("host can temporarily leave the current game and return to it", () => {
  let state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  state = {
    ...state,
    players: [
      ...state.players,
      { id: "player-one", name: "玩家一", color: "sage", online: true },
      { id: "player-two", name: "玩家二", color: "gold", online: true },
    ],
  };
  const entered = enterGame(state, "undercover", () => 0).state;
  assert.equal(entered.phase, "GAME");
  assert.equal(entered.hostInLobby, false);

  const away = hostToLobby(entered);
  assert.equal(away.hostInLobby, true);
  assert.equal(away.phase, "GAME");
  assert.equal(away.gameId, "undercover");
  assert.equal(away.gameState, entered.gameState);

  const back = hostReturnToGame(away);
  assert.equal(back.hostInLobby, false);
  assert.equal(back.gameId, "undercover");
  assert.equal(back.gameState, entered.gameState);

  const ended = backToLobby(back);
  assert.equal(ended.hostInLobby, false);
  assert.equal(ended.phase, "LOBBY");
  assert.equal(ended.gameId, null);
});

test("host temporary leave is ignored outside a running game", () => {
  const state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  assert.equal(hostToLobby(state), state);
});

test("normalizes invite codes with or without the dash", () => {
  assert.equal(normalizeRoomId("ABC-123"), "ABC-123");
  assert.equal(normalizeRoomId("abc123"), "ABC-123");
  assert.equal(normalizeRoomId(" abc 123 "), "ABC-123");
  assert.equal(normalizeRoomId("AB-C123"), "ABC-123");
  assert.equal(normalizeRoomId("ABC12"), "ABC12");
});

test("public undercover snapshots never leak roundResult or identities (B001)", () => {
  const roomPlayers = threePlayers();
  let roomState = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  roomState = {
    ...roomState,
    players: roomPlayers,
    phase: "GAME",
    gameId: "undercover",
    gameState: startUndercoverRound(
      createUndercoverState({ undercover: 1, blank: 0, scopes: [1] }),
      roomPlayers,
      () => 0,
    ).state,
  };
  const playingPub = publicRoom(roomState, { playerId: "host", isHost: true });
  assert.equal("roundResult" in playingPub.game, false);
  assert.equal("cards" in playingPub.game, false);
  assert.equal("votes" in playingPub.game, false);
  assert.equal("lastWordPair" in playingPub.game, false);
  const playingText = JSON.stringify(playingPub.game);
  assert.equal(playingText.includes("normalWord"), false);
  assert.equal(playingText.includes("undercoverWord"), false);
  assert.equal(playingText.includes("undercoverPlayerIds"), false);
  assert.equal(playingText.includes("blankPlayerIds"), false);

  // VOTING 阶段同样不泄露。
  let current = roomState.gameState;
  for (const id of ["host", "player-one", "player-two"]) {
    current = applyVoteReady(current, roomPlayers, id, true).state;
  }
  const votingPub = publicRoom({ ...roomState, gameState: current }, { playerId: "player-one", isHost: false });
  const votingText = JSON.stringify(votingPub.game);
  assert.equal("roundResult" in votingPub.game, false);
  assert.equal(votingText.includes("normalWord"), false);
  assert.equal(votingText.includes("undercoverWord"), false);
});

test("pending join requests are visible only to the host (B012)", () => {
  let state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  state = {
    ...state,
    players: [
      ...state.players,
      { id: "p1", name: "玩家一", color: "sage", online: true },
    ],
    pendingJoinRequests: [{ id: "req-1", playerName: "新人", createdAt: Date.now() }],
  };
  const hostView = publicRoom(state, { playerId: "host", isHost: true });
  const memberView = publicRoom(state, { playerId: "p1", isHost: false });
  assert.equal(hostView.pendingJoinRequests.length, 1);
  assert.deepEqual(memberView.pendingJoinRequests, []);
  // 无查看者时使用最安全默认。
  assert.deepEqual(publicRoom(state).pendingJoinRequests, []);
});

test("room revision increments are carried through projections (B026)", () => {
  const state = createRoomState("ABC-123", "host", "房主", { maxPlayers: 8 });
  assert.equal(state.revision, 0);
  const pub = publicRoom(state, { playerId: "host", isHost: true });
  assert.equal(pub.revision, 0);
  const next = { ...state, revision: state.revision + 1 };
  assert.equal(publicRoom(next, { playerId: "host", isHost: true }).revision, 1);
});
test("kicking the last unconfirmed player in REVEALED starts the next round automatically", () => {
  const roomPlayers = fourPlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "p1", "p2", "p3"]);
  const current = castAll(voting, roomPlayers, { host: "p1", p1: "p2", p2: "p1", p3: "p1" });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  assert.equal(resolved.state.phase, "REVEALED");
  assert.equal(resolved.state.winner, "civilians");
  // host/p2/p3 已确认下一局，p1（卧底）未确认；踢掉 p1 后剩 3 人且全员确认 -> 立即开始下一局。
  let state = resolved.state;
  state = applyNextRoundReady(state, roomPlayers, "host", true, () => 0).state;
  state = applyNextRoundReady(state, roomPlayers, "p2", true, () => 0).state;
  state = applyNextRoundReady(state, roomPlayers, "p3", true, () => 0).state;
  assert.equal(state.phase, "REVEALED");
  const remaining = roomPlayers.filter((player) => player.id !== "p1");
  const removed = roomPlayers.find((player) => player.id === "p1");
  const settled = settleUndercoverRemoval(state, remaining, () => 0, removed);
  assert.equal(settled.started, true);
  assert.equal(settled.state.phase, "PLAYING");
  assert.equal(settled.state.round, 2);
  assert.equal(settled.state.winner, null);
});

test("kicking in REVEALED below the minimum player count blocks the next round", () => {
  const roomPlayers = threePlayers();
  const round = startRoundWith(roomPlayers);
  const voting = startVoting(round.state, roomPlayers, ["host", "player-one", "player-two"]);
  const current = castAll(voting, roomPlayers, {
    host: "player-one",
    "player-one": "player-two",
    "player-two": "player-one",
  });
  const resolved = resolveVoting(current, roomPlayers, () => 0);
  let state = resolved.state;
  // host 与 player-one 已确认，player-two 未确认；踢掉 player-two 后剩 2 人且全员确认 -> 人数不足，阻塞。
  state = applyNextRoundReady(state, roomPlayers, "host", true, () => 0).state;
  state = applyNextRoundReady(state, roomPlayers, "player-one", true, () => 0).state;
  const remaining = roomPlayers.filter((player) => player.id !== "player-two");
  const removed = roomPlayers.find((player) => player.id === "player-two");
  const settled = settleUndercoverRemoval(state, remaining, () => 0, removed);
  assert.equal(settled.started, false);
  assert.equal(settled.state.phase, "REVEALED");
  assert.equal(settled.state.nextRoundBlocked, true);
});