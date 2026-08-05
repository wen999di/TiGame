import assert from "node:assert/strict";
import test from "node:test";

import {
  allOnlinePlayersResponded,
  BLANK_UNDERCOVER_PROBABILITY,
  chooseWordPair,
  createRoundResult,
  dealCards,
  pickRoundWords,
  updatePlayerResponse,
  WORD_GROUPS,
} from "../app/game/deal-cards.ts";

test("deals exactly one undercover card in a three-player game", () => {
  const wordPair = chooseWordPair([1], () => 0);
  const cards = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 1, blank: 0 },
    wordPair,
    1,
    () => 0,
  );

  assert.equal(cards.filter((card) => card.word === wordPair.undercover).length, 1);
  assert.equal(cards.filter((card) => card.word === wordPair.normal).length, 2);
  assert.equal(new Set(cards.map((card) => card.playerId)).size, 3);
});

test("keeps at least one civilian when special-role settings exceed player count", () => {
  const wordPair = chooseWordPair([1], () => 0);
  const cards = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 3, blank: 1 },
    wordPair,
    1,
    () => 0.5,
  );

  assert.equal(cards.filter((card) => card.word === wordPair.undercover).length, 2);
  assert.equal(cards.filter((card) => card.word === wordPair.normal).length, 1);
  assert.equal(cards.filter((card) => card.isBlank).length, 0);
});

test("uses only Chinese words in the word bank", () => {
  for (const group of WORD_GROUPS) {
    assert.ok(group.words.length >= 2, `词库分组至少需要两个词：${group.category}`);
    for (const word of group.words) {
      assert.match(word, /^[\u4E00-\u9FFF0-9A-Za-z·&+：:\-]+$/);
    }
    assert.match(group.category, /^[\u4E00-\u9FFF0-9A-Za-z·&+：:\-]+$/);
  }
});

test("contains at least 500 unique, scoped Chinese word groups", () => {
  assert.ok(WORD_GROUPS.length >= 500);
  const groupKeys = new Set();
  const scopeCounts = new Map();

  for (const group of WORD_GROUPS) {
    assert.equal(new Set(group.words).size, group.words.length, `分组内存在重复词：${group.category}`);
    const groupKey = [...group.words].sort().join("/") + "|" + group.category;
    assert.ok(!groupKeys.has(groupKey), `duplicate word group: ${groupKey}`);
    groupKeys.add(groupKey);
    scopeCounts.set(group.difficulty, (scopeCounts.get(group.difficulty) ?? 0) + 1);
  }

  assert.ok((scopeCounts.get(1) ?? 0) >= 150);
  assert.ok((scopeCounts.get(2) ?? 0) >= 150);
  assert.ok((scopeCounts.get(3) ?? 0) >= 150);
});

test("randomly selects a word group from the requested word-bank scope", () => {
  const firstEasyPair = chooseWordPair([1], () => 0);
  const lastEasyPair = chooseWordPair([1], () => 0.99);

  assert.equal(firstEasyPair.difficulty, 1);
  assert.equal(lastEasyPair.difficulty, 1);
  assert.notEqual(firstEasyPair.words, lastEasyPair.words);
  assert.equal(chooseWordPair([2], () => 0).difficulty, 2);
  assert.equal(chooseWordPair([3], () => 0).difficulty, 3);
});

test("uses every selected word-bank scope when multiple are chosen", () => {
  // 只选标准/烧脑：两端随机数都应落在所选范围内。
  assert.equal(chooseWordPair([2, 3], () => 0).difficulty, 2);
  assert.equal(chooseWordPair([2, 3], () => 0.999).difficulty, 3);
  // 全选时，随机数 0 / 0.999 分别命中轻松和烧脑。
  assert.equal(chooseWordPair([1, 2, 3], () => 0).difficulty, 1);
  assert.equal(chooseWordPair([1, 2, 3], () => 0.999).difficulty, 3);
  // 仅选轻松时不会出现其他范围。
  assert.equal(chooseWordPair([1], () => 0.999).difficulty, 1);
});

test("draws two interchangeable words from a multi-word group", () => {
  const superheroGroup = WORD_GROUPS.find((group) =>
    group.category === "漫威超级英雄"
    && group.words.length === 10
    && ["蜘蛛侠", "钢铁侠", "美国队长", "雷神"].every((word) => group.words.includes(word)),
  );
  assert.ok(superheroGroup);

  const swappedOrder = pickRoundWords(superheroGroup, () => 0);
  assert.deepEqual(swappedOrder, { normal: "钢铁侠", undercover: "蜘蛛侠" });

  let callIndex = 0;
  const noSwapRandom = () => (callIndex++ < 2 ? 0 : 0.99);
  const normalOrder = pickRoundWords(superheroGroup, noSwapRandom);
  assert.deepEqual(normalOrder, { normal: "蜘蛛侠", undercover: "钢铁侠" });

  for (let index = 0; index < 30; index += 1) {
    const pair = pickRoundWords(superheroGroup, Math.random);
    assert.notEqual(pair.normal, pair.undercover);
    assert.ok(superheroGroup.words.includes(pair.normal));
    assert.ok(superheroGroup.words.includes(pair.undercover));
  }
});

test("avoids repeating the same word group in consecutive rounds", () => {
  const firstPair = chooseWordPair([1], () => 0);
  const secondPair = chooseWordPair([1], () => 0, firstPair);

  assert.equal(secondPair.difficulty, 1);
  assert.notEqual(firstPair.words, secondPair.words);
});

test("waits for every online player before advancing a round action", () => {
  const players = [
    { id: "host", online: true },
    { id: "player-one", online: true },
    { id: "player-two", online: false },
  ];
  const hostResponse = updatePlayerResponse([], "host", true);
  const allResponses = updatePlayerResponse(hostResponse, "player-one", true);

  assert.equal(allOnlinePlayersResponded(players, hostResponse), false);
  assert.equal(allOnlinePlayersResponded(players, allResponses), true);
  assert.deepEqual(updatePlayerResponse(allResponses, "player-one", false), ["host"]);
});

test("reveals the assigned undercover players and both words after confirmation", () => {
  const wordPair = chooseWordPair([1], () => 0);
  const cards = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 1, blank: 1 },
    wordPair,
    1,
    () => 0,
  );
  const result = createRoundResult(cards, wordPair);

  assert.equal(result.normalWord, wordPair.normal);
  assert.equal(result.undercoverWord, wordPair.undercover);
  assert.equal(result.undercoverPlayerIds.length, 1);
  assert.equal(result.blankPlayerIds.length, 1);
  // 白板必然是卧底：同一名玩家。
  assert.deepEqual(result.blankPlayerIds, result.undercoverPlayerIds);
});

test("blank only lands on undercovers with a fixed 10% chance", () => {
  assert.equal(BLANK_UNDERCOVER_PROBABILITY, 0.1);
  const wordPair = chooseWordPair([1], () => 0);

  // 掷到 0.09（低于 10%）→ 卧底成为白板，且白板名单与卧底名单一致。
  const hit = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 1, blank: 1 },
    wordPair,
    1,
    () => 0.09,
  );
  const hitResult = createRoundResult(hit, wordPair);
  assert.equal(hit.filter((card) => card.isBlank).length, 1);
  assert.equal(hitResult.undercoverPlayerIds.length, 1);
  assert.deepEqual(hitResult.blankPlayerIds, hitResult.undercoverPlayerIds);

  // 掷到 0.10（恰好等于 10%）→ 不触发。
  const miss = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 1, blank: 1 },
    wordPair,
    1,
    () => 0.1,
  );
  assert.equal(miss.filter((card) => card.isBlank).length, 0);
  assert.deepEqual(createRoundResult(miss, wordPair).blankPlayerIds, []);
});

test("two undercovers are either all blank or none blank", () => {
  const wordPair = chooseWordPair([1], () => 0);
  const players = ["host", "p1", "p2", "p3", "p4"];

  // 命中 10% → 两名卧底同时是白板。
  const hit = dealCards(players, { undercover: 2, blank: 1 }, wordPair, 1, () => 0.09);
  const hitResult = createRoundResult(hit, wordPair);
  assert.equal(hitResult.undercoverPlayerIds.length, 2);
  assert.equal(hitResult.blankPlayerIds.length, 2);
  assert.deepEqual([...hitResult.blankPlayerIds].sort(), [...hitResult.undercoverPlayerIds].sort());

  // 未命中 → 两名卧底都不是白板。
  const miss = dealCards(players, { undercover: 2, blank: 1 }, wordPair, 1, () => 0.99);
  const missResult = createRoundResult(miss, wordPair);
  assert.equal(missResult.undercoverPlayerIds.length, 2);
  assert.deepEqual(missResult.blankPlayerIds, []);
});

test("blank mode off never deals blank cards even when the roll would hit", () => {
  const wordPair = chooseWordPair([1], () => 0);
  const cards = dealCards(
    ["host", "player-one", "player-two"],
    { undercover: 1, blank: 0 },
    wordPair,
    1,
    () => 0,
  );
  assert.equal(cards.filter((card) => card.isBlank).length, 0);
});

test("keeps the reviewed word groups and focused blank-card hints", () => {
  assert.ok(WORD_GROUPS.some((group) =>
    group.category === "饮品" && group.words.includes("咖啡") && group.words.includes("奶茶")));
  assert.ok(WORD_GROUPS.some((group) =>
    group.category === "水上休闲" && group.words.includes("沙滩") && group.words.includes("泳池")));
});