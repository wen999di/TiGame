import type { Player } from "./types.ts";

/** 不要做挑战的禁忌动作词库（牌面不带“不要”，例如“看天花板”）。 */
export const CHALLENGE_ACTIONS = [
  "说“好”", "说“可以”", "说“行”", "说“不行”", "说“对”", "说“不是”",
  "说“没错”", "说“真的”", "说“当然”", "说“可能”", "说“也许”", "说“不知道”",
  "说“随便”", "说“算了”", "说“等等”", "说“等一下”", "说“没事”", "说“没关系”",
  "说“谢谢”", "说“对不起”", "说“然后”", "说“但是”", "说“所以”", "说“因为”",
  "说“其实”", "说“反正”", "说“好吧”", "说“行吧”", "说“怎么了”", "说“为什么”",
  "说“什么”", "说“你确定”", "说“你猜”", "说“我觉得”", "说“我也是”", "说“有道理”",
  "说“差不多”", "说“还行”", "说“不会吧”", "说“真的假的”", "说“厉害”", "说“别闹”",
  "说“没办法”", "说“记得”", "说“快点”", "说“慢点”", "说“再说一遍”", "说“听不清”",
  "说“你呢”", "说“然后呢”", "说“谁啊”", "说“哪里”", "说“什么时候”", "说“明白”",

  "叫出某位玩家的名字", "反问别人", "重复别人刚说的话", "纠正别人",
  "称赞别人", "让别人猜", "让别人等一下", "请别人帮忙",
  "请别人递东西", "询问别人的意见", "给别人一个建议", "让别人重复一遍",
  "让别人说大声一点", "让别人二选一", "问别人喜不喜欢某样东西", "问别人去过哪里",

  "说一个数字", "说一种颜色", "说一种食物", "说一种动物",
  "说一个城市名", "说一个品牌名", "说一个英文单词", "说一句成语",
  "数到三", "连续说两遍同一个词", "说出今天星期几", "用英文回答",

  "笑出声", "点头", "摇头", "回头看", "看天花板", "看向门口",
  "环顾四周", "叹气", "清嗓子", "深呼吸", "抖腿", "跷二郎腿",
  "伸懒腰", "挠头", "摸头发", "摸鼻子", "摸耳朵", "摸下巴",
  "托腮", "抱臂", "捂嘴", "揉眼睛", "身体后仰", "身体前倾",
  "坐直身体", "站起来", "敲桌子", "拿起杯子", "喝水", "拿起桌上的东西",
  "递东西给别人", "接过别人递来的东西", "指向某个人", "指向某个物品",
  "整理自己的衣服", "看时间", "鼓掌", "挥手", "捂脸",
];

export type ChallengeSettings = {
  lives: number;
};

export const DEFAULT_CHALLENGE_SETTINGS: ChallengeSettings = { lives: 3 };

/** 生命数服务端硬上限：防止“玩家数 × 生命数”的同步状态与持久化爆炸（B013）。 */
export const CHALLENGE_MAX_LIVES = 30;

export type ChallengeState = {
  phase: "SETUP" | "PLAYING" | "ENDED";
  /** 玩家 id -> 当前牌（他人可见、自己隐藏）。惩罚时从全局牌池懒抽下一张（N003）。 */
  currentCards: Record<string, string | null>;
  /** 玩家 id -> 剩余生命（开局 = 设置值；奖励 +1；惩罚 -1）。 */
  lives: Record<string, number>;
  /** 全局抽牌池：未被任何玩家持有的牌。 */
  drawPile: string[];
  /** 惩罚/换牌弃掉的牌，牌池耗尽后洗回再抽。 */
  discardPile: string[];
  eliminatedPlayerIds: string[];
  winnerId: string | null;
  settings: ChallengeSettings;
  /** 当前对局内的胜负记录（赢X局/输X局），返回大厅后清空。 */
  records: Record<string, { wins: number; losses: number }>;
  /** 玩家 id -> 未确认的弃牌揭示队列（私密：只发给目标玩家，不进公共快照）。连续惩罚不覆盖，按 eventId 去重/确认（N005/P1）。 */
  pendingReveals: Record<string, Array<{ action: string; eventId: string }>>;
};

export type ChallengePublicState = {
  kind: "challenge";
  phase: "SETUP" | "PLAYING" | "ENDED";
  /** 其他玩家的当前牌；自己永远是 null（自己的牌由服务端私密事件/客户端本地持有）。 */
  visibleCards: Record<string, string | null>;
  lives: Record<string, number>;
  eliminatedPlayerIds: string[];
  winnerId: string | null;
  settings: ChallengeSettings;
  records: Record<string, { wins: number; losses: number }>;
};

/** 按查看者投影挑战状态：自己看不到自己的当前牌，其他人的当前牌公开。 */
export function projectChallengeForViewer(
  state: ChallengeState,
  viewerId: string,
): ChallengePublicState {
  return {
    kind: "challenge",
    phase: state.phase,
    visibleCards: Object.fromEntries(
      Object.entries(state.currentCards).map(([playerId, action]) => [
        playerId,
        playerId === viewerId ? null : action,
      ]),
    ),
    lives: state.lives,
    eliminatedPlayerIds: state.eliminatedPlayerIds,
    winnerId: state.winnerId,
    settings: state.settings,
    records: state.records,
  };
}

/** 无查看者时的最安全默认：所有真实玩家的当前牌都显式隐藏（N004）。 */
export function publicChallengeState(
  state: ChallengeState,
  viewerId: string | null = null,
): ChallengePublicState {
  if (!viewerId) {
    return {
      kind: "challenge",
      phase: state.phase,
      visibleCards: Object.fromEntries(Object.keys(state.currentCards).map((playerId) => [playerId, null])),
      lives: state.lives,
      eliminatedPlayerIds: state.eliminatedPlayerIds,
      winnerId: state.winnerId,
      settings: state.settings,
      records: state.records,
    };
  }
  return projectChallengeForViewer(state, viewerId);
}

function shuffle<T>(items: readonly T[], randomNumber: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomNumber() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

type ChallengeDeck = {
  currentCards: Record<string, string | null>;
  drawPile: string[];
  discardPile: string[];
};

/** 开局/换牌/惩罚统一经过的抽牌函数：当前被持有的牌绝不进抽牌池（B014）。 */
function drawUniqueActionFrom(deck: ChallengeDeck, randomNumber: () => number): { action: string } {
  const held = new Set<string>();
  for (const action of Object.values(deck.currentCards)) if (action) held.add(action);

  let pile = deck.drawPile.filter((action) => !held.has(action));
  if (pile.length === 0) {
    // 补牌时对 discardPile + 词库去重，避免同一张牌重复进入牌池。
    pile = shuffle(
      [...new Set([...deck.discardPile, ...CHALLENGE_ACTIONS])].filter((action) => !held.has(action)),
      randomNumber,
    );
    deck.discardPile = [];
  }
  const [action, ...rest] = pile;
  if (!action) throw new Error("Challenge card pool exhausted");
  deck.drawPile = rest;
  return { action };
}

/** 创建挑战对局：先进入设置阶段，房主配置后由 startChallengeRound 发第一局牌。 */
export function createChallengeState(settings: ChallengeSettings): ChallengeState {
  return {
    phase: "SETUP",
    currentCards: {},
    lives: {},
    drawPile: [],
    discardPile: [],
    eliminatedPlayerIds: [],
    winnerId: null,
    settings,
    records: {},
    pendingReveals: {},
  };
}

/**
 * 从设置阶段开始第一局：每位玩家只发一张当前牌，生命数单独记录；
 * 后续牌在惩罚时才从全局牌池懒抽，避免“玩家数 × 生命数”预发耗尽词库（N003）。
 */
export function startChallengeRound(
  state: ChallengeState,
  players: readonly Player[],
  randomNumber: () => number = Math.random,
): { state: ChallengeState } {
  const deck: ChallengeDeck = {
    currentCards: {},
    drawPile: shuffle([...CHALLENGE_ACTIONS], randomNumber),
    discardPile: [],
  };
  const lives: Record<string, number> = {};
  for (const player of players) {
    lives[player.id] = Math.min(CHALLENGE_MAX_LIVES, Math.max(1, Math.round(state.settings.lives)));
    const { action } = drawUniqueActionFrom(deck, randomNumber);
    deck.currentCards[player.id] = action;
  }
  return {
    state: {
      ...state,
      phase: "PLAYING",
      ...deck,
      lives,
      eliminatedPlayerIds: [],
      winnerId: null,
      records: {},
      pendingReveals: {},
    },
  };
}

function updateChallengeRecords(
  records: Record<string, { wins: number; losses: number }>,
  players: readonly Player[],
  winnerId: string,
): Record<string, { wins: number; losses: number }> {
  return Object.fromEntries(players.map((player) => {
    const prev = records[player.id] ?? { wins: 0, losses: 0 };
    return [player.id, player.id === winnerId
      ? { wins: prev.wins + 1, losses: prev.losses }
      : { wins: prev.wins, losses: prev.losses + 1 }];
  }));
}

/** 一名玩家犯规，由另一名玩家对其进行一次惩罚：弃掉当前牌（少一条命），必要时懒抽下一张。 */
export function applyChallengePenalize(
  state: ChallengeState,
  players: readonly Player[],
  penalizerId: string,
  targetId: string,
  randomNumber: () => number = Math.random,
): { state: ChallengeState } {
  if (state.phase !== "PLAYING") return { state };
  const inGame = players.filter((player) => !player.joinNextRound);
  if (!inGame.some((player) => player.id === penalizerId)) return { state };
  const target = inGame.find((player) => player.id === targetId);
  if (!target || state.eliminatedPlayerIds.includes(targetId)) return { state };

  const discardedAction = state.currentCards[targetId];
  if (!discardedAction) return { state };
  const nextLives = Math.max(0, (state.lives[targetId] ?? 0) - 1);
  const lives = { ...state.lives, [targetId]: nextLives };
  const discardPile = [...state.discardPile, discardedAction];
  // 懒抽牌：还有命时从全局牌池抽下一张作为新当前牌；没命了直接淘汰。
  let currentCards = { ...state.currentCards, [targetId]: null };
  let drawPile = state.drawPile;
  if (nextLives > 0) {
    const deck: ChallengeDeck = {
      currentCards,
      drawPile: state.drawPile,
      discardPile,
    };
    const { action } = drawUniqueActionFrom(deck, randomNumber);
    currentCards = { ...currentCards, [targetId]: action };
    drawPile = deck.drawPile;
  }
  const eliminatedPlayerIds = nextLives === 0 && !state.eliminatedPlayerIds.includes(targetId)
    ? [...state.eliminatedPlayerIds, targetId]
    : state.eliminatedPlayerIds;
  const active = inGame.filter((player) => !eliminatedPlayerIds.includes(player.id));
  const winnerId = active.length <= 1 ? active[0]?.id ?? null : null;
  const records = winnerId ? updateChallengeRecords(state.records, inGame, winnerId) : state.records;
  return {
    state: {
      ...state,
      phase: winnerId ? "ENDED" : "PLAYING",
      currentCards,
      lives,
      drawPile,
      discardPile,
      eliminatedPlayerIds,
      winnerId,
      records,
      // 按玩家分别记录（B015）；同一玩家连续惩罚按队列保留，不覆盖（P1）。
      pendingReveals: {
        ...state.pendingReveals,
        [targetId]: [
          ...(state.pendingReveals[targetId] ?? []),
          { action: discardedAction, eventId: crypto.randomUUID() },
        ],
      },
    },
  };
}

/** 被惩罚玩家看完弃牌后点击丢弃：按 eventId 移除该条揭示，不影响队列中的其它揭示。 */
export function dismissChallengeLostCard(
  state: ChallengeState,
  playerId: string,
  eventId: string,
): ChallengeState {
  const list = state.pendingReveals[playerId];
  if (!list || list.length === 0) return state;
  const nextList = list.filter((item) => item.eventId !== eventId);
  if (nextList.length === list.length) return state;
  const pendingReveals = { ...state.pendingReveals, [playerId]: nextList };
  if (nextList.length === 0) delete pendingReveals[playerId];
  return { ...state, pendingReveals };
}

/** 房主让别人换一张当前的牌：弃掉当前牌，从全局牌池抽一张（总牌数与生命不变）。 */
export function applyChallengeSwap(
  state: ChallengeState,
  players: readonly Player[],
  targetId: string,
  randomNumber: () => number = Math.random,
): { state: ChallengeState } {
  if (state.phase !== "PLAYING") return { state };
  const inGame = players.filter((player) => !player.joinNextRound);
  const target = inGame.find((player) => player.id === targetId);
  if (!target || state.eliminatedPlayerIds.includes(targetId)) return { state };
  const current = state.currentCards[targetId];
  if (!current) return { state };
  const deck: ChallengeDeck = {
    currentCards: { ...state.currentCards, [targetId]: null },
    drawPile: state.drawPile,
    discardPile: [...state.discardPile, current],
  };
  const { action } = drawUniqueActionFrom(deck, randomNumber);
  return {
    state: {
      ...state,
      currentCards: { ...state.currentCards, [targetId]: action },
      drawPile: deck.drawPile,
      discardPile: deck.discardPile,
    },
  };
}

/**
 * 奖励：玩家猜中自己的当前牌后——
 * 丢弃当前展示的牌，从全局牌池抽两张新牌加入牌堆，展示其中一张，并加一条生命。
 * 展示的那张成为新的当前牌；另一张对应新增生命，在下次惩罚时才懒抽（N003），
 * 每人生命不得超过硬上限。
 */
export function applyChallengeReward(
  state: ChallengeState,
  players: readonly Player[],
  playerId: string,
  randomNumber: () => number = Math.random,
): { state: ChallengeState } {
  if (state.phase !== "PLAYING") return { state };
  const inGame = players.filter((player) => !player.joinNextRound);
  if (!inGame.some((player) => player.id === playerId)) return { state };
  const discardedAction = state.currentCards[playerId];
  if (!discardedAction) return { state };
  const currentLives = state.lives[playerId] ?? 0;
  if (currentLives >= CHALLENGE_MAX_LIVES) return { state };
  // 抽牌时先把自己排除在“持有牌”之外，避免抽到刚丢掉的牌（B014）。
  const deck: ChallengeDeck = {
    currentCards: { ...state.currentCards, [playerId]: null },
    drawPile: state.drawPile,
    discardPile: [...state.discardPile, discardedAction],
  };
  const { action } = drawUniqueActionFrom(deck, randomNumber);
  return {
    state: {
      ...state,
      currentCards: { ...state.currentCards, [playerId]: action },
      lives: { ...state.lives, [playerId]: currentLives + 1 },
      drawPile: deck.drawPile,
      discardPile: deck.discardPile,
    },
  };
}

/** 游戏结束后再来一局：重新按生命数发牌（胜负记录保留到返回大厅）。 */
export function restartChallenge(
  state: ChallengeState,
  players: readonly Player[],
  randomNumber: () => number = Math.random,
): ChallengeState {
  return { ...startChallengeRound(createChallengeState(state.settings), players, randomNumber).state, records: state.records };
}

/** 玩家被移出后清理其数据，并重算胜负。 */
export function settleChallengeRemoval(
  state: ChallengeState,
  players: readonly Player[],
): ChallengeState {
  const playerIds = new Set(players.map((player) => player.id));
  // playerIds 由同一个 players 派生，这里不再重复判断（B042）。
  const inGame = players.filter((player) => !player.joinNextRound);
  const currentCards = Object.fromEntries(Object.entries(state.currentCards).filter(([id]) => playerIds.has(id)));
  const lives = Object.fromEntries(Object.entries(state.lives).filter(([id]) => playerIds.has(id)));
  const eliminatedPlayerIds = state.eliminatedPlayerIds.filter((id) => playerIds.has(id));
  const pendingReveals = Object.fromEntries(Object.entries(state.pendingReveals).filter(([id]) => playerIds.has(id)));
  const active = inGame.filter((player) => !eliminatedPlayerIds.includes(player.id));
  const winnerId = state.phase === "SETUP"
    ? null
    : state.phase === "ENDED"
      ? state.winnerId
      : active.length <= 1
        ? active[0]?.id ?? null
        : null;
  const records = state.phase === "ENDED" || !winnerId
    ? state.records
    : updateChallengeRecords(state.records, inGame, winnerId);
  return {
    ...state,
    currentCards,
    lives,
    eliminatedPlayerIds,
    winnerId,
    records,
    pendingReveals,
    phase: winnerId ? "ENDED" : state.phase,
  };
}

export function sanitizeChallengeSettings(
  value: Partial<ChallengeSettings> | undefined,
  fallback: ChallengeSettings,
): ChallengeSettings {
  // 服务端硬上限 30：更高的数值也不得预创建“玩家数 × 生命数”的完整数组（B013）。
  const lives = typeof value?.lives === "number" && !Number.isNaN(value.lives)
    ? Math.min(CHALLENGE_MAX_LIVES, Math.max(1, Math.round(value.lives)))
    : Math.min(CHALLENGE_MAX_LIVES, Math.max(1, Math.round(fallback.lives)));
  return { lives };
}