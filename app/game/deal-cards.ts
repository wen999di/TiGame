import { WORD_GROUPS, type WordBankScope, type WordGroup } from "./word-bank.ts";

export { WORD_GROUPS, type WordBankScope, type WordGroup } from "./word-bank.ts";

export type WordPair = {
  normal: string;
  undercover: string;
  category: string;
  difficulty: WordBankScope;
  words: readonly string[];
};

export type DealtCard = {
  playerId: string;
  round: number;
  word: string;
  isBlank: boolean;
  category: string;
};

export type RoundResult = {
  normalWord: string;
  undercoverWord: string;
  category: string;
  undercoverPlayerIds: string[];
  blankPlayerIds: string[];
};

/** 卧底全员成为白板的固定概率：开启白板玩法时，每局掷一次。 */
export const BLANK_UNDERCOVER_PROBABILITY = 0.1;

type RoleSettings = {
  undercover: number;
  blank: number;
};

function groupFromWordPair(wordPair: WordPair): WordGroup {
  // WordPair.words 来自词库分组，保证至少两个词；重组为元组以满足 WordGroup 约束。
  const [first, second, ...rest] = wordPair.words;
  return { words: [first, second, ...rest], category: wordPair.category, difficulty: wordPair.difficulty };
}

function sameWordGroup(left: WordGroup, right: WordGroup): boolean {
  return left.category === right.category
    && left.difficulty === right.difficulty
    && left.words.length === right.words.length
    && left.words.every((word, index) => word === right.words[index]);
}

export function chooseWordGroup(
  scopes: readonly WordBankScope[],
  randomNumber: () => number = Math.random,
  previousGroup?: WordGroup,
): WordGroup {
  const selectedScopes = new Set(
    Array.isArray(scopes)
      ? scopes.filter((scope) => scope === 1 || scope === 2 || scope === 3)
      : [],
  );
  // 防御：范围列表为空或非法时退回全词库，保证一定能抽到词。
  const scopedGroups = WORD_GROUPS.filter((group) =>
    selectedScopes.size > 0
      ? selectedScopes.has(group.difficulty)
      : true,
  );
  const availableGroups = scopedGroups.filter((group) => !previousGroup || !sameWordGroup(group, previousGroup));
  const candidates = availableGroups.length > 0 ? availableGroups : scopedGroups;
  return candidates[Math.floor(randomNumber() * candidates.length)];
}

export function pickRoundWords(
  group: WordGroup,
  randomNumber: () => number = Math.random,
): Pick<WordPair, "normal" | "undercover"> {
  if (group.words.length < 2) {
    throw new Error(`词库分组至少需要两个词：${group.category}`);
  }
  const firstIndex = Math.floor(randomNumber() * group.words.length);
  let secondIndex = Math.floor(randomNumber() * (group.words.length - 1));
  if (secondIndex >= firstIndex) secondIndex += 1;
  const firstWord = group.words[firstIndex];
  const secondWord = group.words[secondIndex];
  const swapRoles = randomNumber() < 0.5;
  return swapRoles
    ? { normal: secondWord, undercover: firstWord }
    : { normal: firstWord, undercover: secondWord };
}

export function chooseWordPair(
  scopes: readonly WordBankScope[],
  randomNumber: () => number = Math.random,
  previousWordPair?: WordPair,
): WordPair {
  const group = chooseWordGroup(
    scopes,
    randomNumber,
    previousWordPair ? groupFromWordPair(previousWordPair) : undefined,
  );
  const { normal, undercover } = pickRoundWords(group, randomNumber);
  return { normal, undercover, category: group.category, difficulty: group.difficulty, words: group.words };
}

export function updatePlayerResponse(responsePlayerIds: readonly string[], playerId: string, ready: boolean) {
  const nextResponsePlayerIds = new Set(responsePlayerIds);
  if (ready) nextResponsePlayerIds.add(playerId);
  else nextResponsePlayerIds.delete(playerId);
  return [...nextResponsePlayerIds];
}

export function allOnlinePlayersResponded(
  players: readonly { id: string; online: boolean }[],
  responsePlayerIds: readonly string[],
) {
  const responses = new Set(responsePlayerIds);
  const onlinePlayers = players.filter((player) => player.online);
  return onlinePlayers.length > 0 && onlinePlayers.every((player) => responses.has(player.id));
}

export function createRoundResult(dealtCards: readonly DealtCard[], wordPair: WordPair): RoundResult {
  return {
    normalWord: wordPair.normal,
    undercoverWord: wordPair.undercover,
    category: wordPair.category,
    // 白板必然是卧底：白板卡也计入卧底名单。
    undercoverPlayerIds: dealtCards
      .filter((card) => card.isBlank || card.word === wordPair.undercover)
      .map((card) => card.playerId),
    blankPlayerIds: dealtCards.filter((card) => card.isBlank).map((card) => card.playerId),
  };
}

function shufflePlayerIds(playerIds: readonly string[], randomNumber: () => number) {
  const shuffledPlayerIds = [...playerIds];
  for (let index = shuffledPlayerIds.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomNumber() * (index + 1));
    [shuffledPlayerIds[index], shuffledPlayerIds[swapIndex]] = [shuffledPlayerIds[swapIndex], shuffledPlayerIds[index]];
  }
  return shuffledPlayerIds;
}

export function dealCards(
  playerIds: readonly string[],
  settings: RoleSettings,
  wordPair: WordPair,
  round: number,
  randomNumber: () => number = Math.random,
): DealtCard[] {
  const shuffledPlayerIds = shufflePlayerIds(playerIds, randomNumber);
  const availableSpecialRoles = Math.max(0, shuffledPlayerIds.length - 1);
  const undercoverCount = Math.min(Math.max(0, settings.undercover), availableSpecialRoles);
  // 白板只可能是卧底：开启白板玩法后，按固定 10% 概率掷一次，
  // 所有卧底同时成为白板（或同时都不是），不产生独立的平民白板。
  const undercoversAreBlank = settings.blank > 0
    && undercoverCount > 0
    && randomNumber() < BLANK_UNDERCOVER_PROBABILITY;

  return shuffledPlayerIds.map((playerId, index) => {
    if (index < undercoverCount) {
      return undercoversAreBlank
        ? { playerId, round, word: wordPair.category, isBlank: true, category: wordPair.category }
        : { playerId, round, word: wordPair.undercover, isBlank: false, category: wordPair.category };
    }
    return { playerId, round, word: wordPair.normal, isBlank: false, category: wordPair.category };
  });
}