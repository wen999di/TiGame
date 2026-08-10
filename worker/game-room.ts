import { ROOM_ID_PATTERN, normalizeRoomId } from "../app/game/room-id.ts";
import {
  decodeAvatarUploadFrame,
  encodeAvatarDeliveryFrame,
  type AvatarMime,
} from "../app/game/avatar-frame.ts";
import {
  GAME_LIST,
  ROOM_MAX_PLAYERS,
  addPendingRequest,
  approveJoinRequest,
  backToLobby,
  createRoomState,
  enterGame,
  hostReturnToGame,
  hostToLobby,
  kickPlayer,
  publicRoom,
  rejectJoinRequest,
  resolveUndercoverVote,
  sanitizeRoomSettings,
  settleAfterRemoval,
  type GameId,
  type PendingJoinRequest,
  type Player,
  type RoomSettings,
  type RoomState,
} from "../app/game/room.ts";
import {
  applyNextRoundReady,
  applyVote,
  applyVoteReady,
  sanitizeUndercoverSettings,
  startUndercoverRound,
  type UndercoverSettings,
  type UndercoverState,
} from "../app/game/undercover.ts";
import {
  applyChallengePenalize,
  applyChallengeReward,
  applyChallengeSwap,
  dismissChallengeLostCard,
  restartChallenge,
  sanitizeChallengeSettings,
  startChallengeRound,
  type ChallengeSettings,
  type ChallengeState,
} from "../app/game/challenge.ts";
import {
  addMahjongPlayer,
  applyMahjongResetReady,
  applyMahjongSettleReady,
  applyMahjongCollect,
  applyMahjongCollectVote,
  applyMahjongTransfer,
  normalizeMahjongState,
  type MahjongState,
} from "../app/game/mahjong.ts";

const KICKED_CLOSE_CODE = 4003;
const TIMEOUT_CLOSE_CODE = 4001;
// 所有玩家都离线超过该时长后，自动关闭房间并销毁房间数据。
const ALL_OFFLINE_LIMIT_MS = 60 * 60 * 1000;
// 待批准申请上限与过期时间（过期时同时删除对应 token）。
const JOIN_REQUEST_MAX = 32;
const JOIN_REQUEST_TTL_MS = 10 * 60 * 1000;
// 批准时旧申请凭证只保留短暂重叠期，避免“批准时恰好断线、新凭证未送达”被锁在门外。
const TOKEN_OVERLAP_MS = 10 * 60 * 1000;
// WebSocket 协议严格校验：消息大小与频率上限。
const MAX_MESSAGE_BYTES = 16 * 1024;
// WebSocket 握手用单次使用、30 秒有效的 ticket（B021）。
const WS_TICKET_TTL_MS = 30_000;
const COMMAND_RATE_LIMIT = 120;
const COMMAND_RATE_WINDOW_MS = 10_000;

type WsAttachment = {
  playerId: string;
  pending: boolean;
  connectedAt: number;
  commandWindowStartedAt: number;
  commandCount: number;
  avatarUpdatedAt?: number;
};

type StoredAvatar = { mime: AvatarMime; bytes: ArrayBuffer };

type TokenKind = "host" | "join-request" | "member";

type WsTicketRecord = { ticket: string; playerId: string; issuedAt: number; expiresAt: number };

type TokenRecord = {
  token: string;
  kind: TokenKind;
  issuedAt: number;
  expiresAt: number | null;
};

type PersistedData = {
  room: RoomState;
  tokens: Record<string, TokenRecord[]>;
  /** 麻将转分幂等记录：按玩家隔离、有界保存（最近 128 条）。 */
  processedTransfers: Record<string, Array<{ operationId: string; targetId: string; points: number; revision: number }>>;
};

type Viewer = { playerId: string; isHost: boolean };

type RoomEvent = { game: string; kind: string; playerId: string };

type MutationResult = {
  state: RoomState;
  changed: boolean;
  event?: RoomEvent;
  privateEvents?: Array<{ playerId: string; message: unknown }>;
};

type WorkerWebSocket = {
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment<T>(): T | null;
};

type RoomNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
};

type DurableObjectContext = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(time: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  };
  acceptWebSocket(ws: WorkerWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerWebSocket[];
  blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<unknown>;
  setWebSocketAutoResponse(pair: unknown): void;
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function safeSend(ws: WorkerWebSocket, data: unknown) {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // The connection may already be closing; broadcast to others is unaffected.
  }
}

function safeSendBinary(ws: WorkerWebSocket, data: ArrayBuffer) {
  try {
    ws.send(data);
  } catch {
    // The connection may already be closing; avatar replay can wait for reconnect.
  }
}

/** 昵称查重比较键：Unicode 规范化 + 去首尾空格 + 小写（B047）。 */
function nameCompareKey(name: string): string {
  try {
    return name.normalize("NFKC").trim().toLocaleLowerCase();
  } catch {
    return name.trim().toLocaleLowerCase();
  }
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 旧房间若还带 Base64 avatarData，加载时立即从内存投影中剥离，后续持久化自然清掉。 */
function stripLegacyAvatarData(room: RoomState | null): RoomState | null {
  if (!room) return room;
  let changed = false;
  const players = room.players.map((player) => {
    const legacy = player as Player & { avatarData?: unknown };
    if (!("avatarData" in legacy)) return player;
    const { avatarData: _avatarData, ...clean } = legacy;
    void _avatarData;
    changed = true;
    return clean as Player;
  });
  const pendingJoinRequests = room.pendingJoinRequests.map((request) => {
    const legacy = request as PendingJoinRequest & { avatarData?: unknown };
    if (!("avatarData" in legacy)) return request;
    const { avatarData: _avatarData, ...clean } = legacy;
    void _avatarData;
    changed = true;
    return clean as PendingJoinRequest;
  });
  return changed ? { ...room, players, pendingJoinRequests } : room;
}

/** 迁移旧版“谁是卧底”设置：词库范围由单个 difficulty 数字改为 scopes 数组。 */
function migrateLegacyUndercoverSettings(room: RoomState | null): RoomState | null {
  if (!room || room.gameId !== "undercover" || !room.gameState) return room;
  const settings = (room.gameState as UndercoverState).settings as UndercoverSettings & { difficulty?: number };
  if (Array.isArray(settings.scopes) && settings.scopes.length > 0) return room;
  const scopes: UndercoverSettings["scopes"] =
    settings.difficulty === 1 || settings.difficulty === 2 || settings.difficulty === 3
      ? [settings.difficulty]
      : [1];
  return {
    ...room,
    gameState: {
      ...(room.gameState as UndercoverState),
      settings: { undercover: settings.undercover, blank: settings.blank, scopes },
    },
  };
}

function isPendingJoinRequest(room: RoomState, playerId: string) {
  return room.pendingJoinRequests.some((item) => item.id === playerId);
}

export class GameRoom {
  private roomState: RoomState | null = null;
  private tokens: Record<string, TokenRecord[]> = {};
  private processedTransfers: Record<string, Array<{ operationId: string; targetId: string; points: number; revision: number }>> = {};
  /** WebSocket ticket 持久化在 storage，避免 DO 休眠/回收后实例内 Map 丢失（N002）。null 表示尚未从 storage 加载。 */
  /** 每个玩家最多一张待使用 ticket（P0-02），以 playerId 为键。 */
  private wsTickets: Record<string, WsTicketRecord> | null = null;

  constructor(
    private ctx: DurableObjectContext,
    private _env: { ROOM?: RoomNamespace },
  ) {
    // Hibernation API：匹配的 ping/pong 在不唤醒休眠对象的情况下完成，
    // 因此不再需要每分钟 heartbeat Alarm（B005）。
    const Pair = (globalThis as unknown as {
      WebSocketRequestResponsePair?: new (request: string, response: string) => unknown;
    }).WebSocketRequestResponsePair;
    if (Pair) {
      try {
        this.ctx.setWebSocketAutoResponse(new Pair("ping", "pong"));
      } catch {
        // 运行时不支持时忽略；应用层仍接受 pong 消息。
      }
    }
  }

  private async loadData(): Promise<PersistedData | null> {
    if (this.roomState) {
      return { room: this.roomState, tokens: this.tokens, processedTransfers: this.processedTransfers };
    }
    const data = await this.ctx.storage.get<PersistedData>("data");
    this.roomState = data?.room ?? null;
    this.roomState = stripLegacyAvatarData(this.roomState);
    this.roomState = migrateLegacyUndercoverSettings(this.roomState);
    // 旧房间快照可能缺少“向所有人收取”相关字段，加载时补齐默认值。
    if (this.roomState?.gameId === "mahjong" && this.roomState.gameState) {
      this.roomState = {
        ...this.roomState,
        gameState: normalizeMahjongState(this.roomState.gameState as MahjongState),
      };
    }
    this.tokens = this.migrateTokens(data?.tokens);
    this.processedTransfers = data?.processedTransfers ?? {};
    this.pruneExpiredTokens();
    return data ?? null;
  }

  /** 兼容旧数据：字符串 token、字符串数组、以及新式记录数组。 */
  private migrateTokens(raw: unknown): Record<string, TokenRecord[]> {
    const result: Record<string, TokenRecord[]> = {};
    if (!raw || typeof raw !== "object") return result;
    const now = Date.now();
    for (const [playerId, value] of Object.entries(raw as Record<string, unknown>)) {
      const records: TokenRecord[] = [];
      const push = (token: unknown, kind: TokenKind, expiresAt: number | null) => {
        if (typeof token === "string" && token) {
          records.push({ token, kind, issuedAt: now, expiresAt });
        }
      };
      if (typeof value === "string") {
        push(value, "member", null);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            push(item, "member", null);
          } else if (item && typeof item === "object") {
            const record = item as Partial<TokenRecord>;
            push(record.token, record.kind === "join-request" ? "join-request" : "member", typeof record.expiresAt === "number" ? record.expiresAt : null);
          }
        }
      }
      if (records.length > 0) result[playerId] = records;
    }
    return result;
  }

  private pruneExpiredTokens(now = Date.now()) {
    for (const [playerId, records] of Object.entries(this.tokens)) {
      const valid = records.filter((record) => record.expiresAt === null || record.expiresAt > now);
      if (valid.length === 0) delete this.tokens[playerId];
      else if (valid.length !== records.length) this.tokens[playerId] = valid;
    }
  }

  private validTokenFor(playerId: string, token: string, now = Date.now()): boolean {
    const records = this.tokens[playerId] ?? [];
    return records.some((record) => record.token === token && (record.expiresAt === null || record.expiresAt > now));
  }

  private async persist() {
    if (!this.roomState) return;
    await this.ctx.storage.put("data", {
      room: this.roomState,
      tokens: this.tokens,
      processedTransfers: this.processedTransfers,
    } satisfies PersistedData);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocket(request, url);
    }

    if (request.method === "POST" && (url.pathname === "/api/rooms" || url.pathname === "/create")) {
      return this.createRoom(request);
    }
    if (request.method === "POST" && (url.pathname === "/api/join-requests" || url.pathname === "/join")) {
      return this.requestJoin(request);
    }
    if (request.method === "POST" && url.pathname === "/api/ws-ticket") {
      return this.issueWsTicket(request);
    }
    if (request.method === "GET") {
      const match = url.pathname.match(/\/api\/rooms\/([A-Z0-9-]{6,7})$/i) ?? url.pathname.match(/\/room-info\/([A-Z0-9-]{6,7})$/i);
      if (match) return this.getRoomInfo(request, normalizeRoomId(match[1]));
    }
    return json({ error: "not found" }, 404);
  }

  private async createRoom(request: Request): Promise<Response> {
    const payload = (await request.json().catch(() => null)) as {
      roomId?: string;
      hostName?: string;
      settings?: Partial<RoomSettings>;
    } | null;
    const roomId = normalizeRoomId(payload?.roomId);
    if (!ROOM_ID_PATTERN.test(roomId) || !payload) {
      return json({ error: "房间信息不完整" }, 400);
    }
    const defaultSettings: RoomSettings = { maxPlayers: ROOM_MAX_PLAYERS };
    const settings = sanitizeRoomSettings(payload.settings, defaultSettings);
    const hostName = payload.hostName?.trim() || "房主";
    let existing: PersistedData | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      existing = await this.loadData();
      if (existing) return;
      const hostId = crypto.randomUUID();
      const token = crypto.randomUUID();
      this.roomState = createRoomState(roomId, hostId, hostName, settings);
      this.syncAllOfflineState();
      this.tokens = {
        [hostId]: [{ token, kind: "host", issuedAt: Date.now(), expiresAt: null }],
      };
      await this.persist();
      await this.syncAlarm();
    });
    if (existing || !this.roomState) {
      return json({ error: "房间号冲突，请重试" }, 409);
    }
    return json({
      roomId,
      playerId: this.roomState.hostId,
      token: this.tokens[this.roomState.hostId]?.at(-1)?.token ?? "",
      room: publicRoom(this.roomState, { playerId: this.roomState.hostId, isHost: true }),
    }, 201);
  }

  private async requestJoin(request: Request): Promise<Response> {
    const payload = (await request.json().catch(() => null)) as {
      roomId?: string;
      playerName?: string;
      resumePlayerId?: string;
      resumeToken?: string;
    } | null;
    const roomId = normalizeRoomId(payload?.roomId);
    if (!ROOM_ID_PATTERN.test(roomId) || !payload) {
      return json({ error: "加入信息不完整" }, 400);
    }
    await this.loadData();
    if (!this.roomState) return json({ error: "房间不存在或已结束" }, 404);
    const resumePlayerId = typeof payload.resumePlayerId === "string" ? payload.resumePlayerId : "";
    const resumeToken = typeof payload.resumeToken === "string" ? payload.resumeToken : "";
    if (resumePlayerId && resumeToken) {
      const resumed = Boolean(
        this.validTokenFor(resumePlayerId, resumeToken)
        && (isPendingJoinRequest(this.roomState, resumePlayerId)
          || this.roomState.players.some((player) => player.id === resumePlayerId)),
      );
      if (resumed) {
        const validTokens = this.tokens[resumePlayerId] ?? [];
        return json({
          playerId: resumePlayerId,
          token: validTokens.at(-1)?.token ?? resumeToken,
          resumed: true,
        }, 200);
      }
    }
    if (this.roomState.players.length >= ROOM_MAX_PLAYERS) {
      return json({ error: "房间人数已满" }, 409);
    }
    if (this.roomState.pendingJoinRequests.length >= JOIN_REQUEST_MAX) {
      return json({ error: "待确认的申请太多，请稍后再试" }, 409);
    }
    const playerName = payload.playerName?.trim().slice(0, 12) || "新玩家";
    const nameKey = nameCompareKey(playerName);
    const nameTaken = this.roomState.players.some((player) => nameCompareKey(player.name) === nameKey)
      || this.roomState.pendingJoinRequests.some((request) => nameCompareKey(request.playerName) === nameKey);
    if (nameTaken) {
      return json({ error: "昵称重复，请换一个昵称" }, 409);
    }
    const playerId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const requestEntry: PendingJoinRequest = {
      id: playerId,
      playerName,
      createdAt: Date.now(),
    };
    this.roomState = {
      ...addPendingRequest(this.roomState, requestEntry),
      revision: this.roomState.revision + 1,
    };
    this.tokens[playerId] = [{ token, kind: "join-request", issuedAt: Date.now(), expiresAt: Date.now() + JOIN_REQUEST_TTL_MS }];
    await this.persist();
    await this.syncAlarm();
    this.broadcastRoom();
    return json({ playerId, token }, 201);
  }

  private async getRoomInfo(request: Request, roomId: string): Promise<Response> {
    await this.loadData();
    if (!this.roomState) return json({ error: "房间不存在或已结束" }, 404);
    // URL 中的 roomId 必须与当前 DO 对象的房间一致（B044）。
    if (roomId !== this.roomState.roomId) {
      return json({ error: "房间不存在或已结束" }, 404);
    }
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId") ?? "";
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const sessionValid = Boolean(playerId && token && this.validTokenFor(playerId, token));
    const member = sessionValid
      && (this.roomState.players.some((player) => player.id === playerId)
        || isPendingJoinRequest(this.roomState, playerId));
    return json({
      roomId: this.roomState.roomId,
      revision: this.roomState.revision,
      playerCount: this.roomState.players.length,
      maxPlayers: ROOM_MAX_PLAYERS,
      phase: this.roomState.phase,
      gameId: this.roomState.gameId,
      member,
    });
  }

  /** 认证 HTTP：校验长期 token 后签发 30 秒、单次使用的 ticket（B021）。 */
  private async issueWsTicket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = normalizeRoomId(url.searchParams.get("roomId"));
    const playerId = url.searchParams.get("playerId") ?? "";
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!ROOM_ID_PATTERN.test(roomId) || !playerId || !token) {
      return json({ error: "invalid-session" }, 403);
    }
    await this.loadData();
    if (!this.roomState) return json({ error: "room-not-found" }, 404);
    if (!this.validTokenFor(playerId, token)) {
      return json({ error: "invalid-session" }, 403);
    }
    const isPlayer = this.roomState.players.some((player) => player.id === playerId);
    const isPending = !isPlayer && isPendingJoinRequest(this.roomState, playerId);
    if (!isPlayer && !isPending) {
      return json({ error: "invalid-session" }, 403);
    }
    const tickets = await this.loadTickets();
    this.pruneExpiredTickets(tickets, Date.now());
    const now = Date.now();
    const previous = tickets[playerId];
    // 同一玩家 1 秒内只能签发一张 ticket。
    if (previous && now - previous.issuedAt < 1_000) {
      return json({ error: "too-many-requests" }, 429);
    }
    // 全房间 ticket 总量上限：正式玩家 + 待审批 + 少量余量。
    const ticketBudget = this.roomState.players.length + this.roomState.pendingJoinRequests.length + 8;
    if (!tickets[playerId] && Object.keys(tickets).length >= Math.max(1, ticketBudget)) {
      return json({ error: "too-many-requests" }, 429);
    }
    const record: WsTicketRecord = {
      ticket: crypto.randomUUID(),
      playerId,
      issuedAt: now,
      expiresAt: now + WS_TICKET_TTL_MS,
    };
    // 覆盖旧 ticket，而不是无限累积（P0-02）。
    tickets[playerId] = record;
    await this.saveTickets();
    return json({ ticket: record.ticket }, 200);
  }

  private async loadTickets(): Promise<Record<string, WsTicketRecord>> {
    if (!this.wsTickets) {
      this.wsTickets = (await this.ctx.storage.get<Record<string, WsTicketRecord>>("ws-tickets")) ?? {};
    }
    return this.wsTickets;
  }

  private async saveTickets(): Promise<void> {
    await this.ctx.storage.put("ws-tickets", this.wsTickets ?? {});
  }

  private pruneExpiredTickets(tickets: Record<string, WsTicketRecord>, now = Date.now()) {
    for (const [playerId, record] of Object.entries(tickets)) {
      if (record.expiresAt < now) delete tickets[playerId];
    }
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const roomId = normalizeRoomId(url.searchParams.get("roomId"));
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!ROOM_ID_PATTERN.test(roomId) || !ticket) {
      return json({ error: "invalid-session" }, 403);
    }
    const tickets = await this.loadTickets();
    const ticketEntry = Object.values(tickets).find((record) => record.ticket === ticket);
    if (!ticketEntry) {
      return json({ error: "invalid-session" }, 403);
    }
    if (ticketEntry.expiresAt < Date.now()) {
      delete tickets[ticketEntry.playerId];
      await this.saveTickets();
      return json({ error: "invalid-session" }, 403);
    }
    // 单次使用：握手消费后立即作废（原子读写由 DO 并发模型保证）。
    delete tickets[ticketEntry.playerId];
    await this.saveTickets();
    const playerId = ticketEntry.playerId;

    await this.loadData();
    if (!this.roomState) return json({ error: "room-not-found" }, 404);
    const isPlayer = this.roomState.players.some((player) => player.id === playerId);
    const isPending = !isPlayer && isPendingJoinRequest(this.roomState, playerId);
    if (!isPlayer && !isPending) {
      return json({ error: "invalid-session" }, 403);
    }

    const pair = new (globalThis as unknown as { WebSocketPair: new () => { 0: WorkerWebSocket; 1: WorkerWebSocket } }).WebSocketPair();
    const server = pair[1];
    const now = Date.now();
    this.ctx.acceptWebSocket(server, [
      isPending ? "pending" : "approved",
      `player:${playerId}`,
    ]);
    const attachment: WsAttachment = {
      playerId,
      pending: isPending,
      connectedAt: now,
      commandWindowStartedAt: now,
      commandCount: 0,
    };
    server.serializeAttachment(attachment);

    if (isPlayer) {
      this.roomState = {
        ...this.roomState,
        revision: this.roomState.revision + 1,
        players: this.roomState.players.map((player) =>
          player.id === playerId ? { ...player, online: true, offlineSince: undefined } : player),
      };
      this.syncAllOfflineState();
      await this.persist();
      safeSend(server, {
        type: "hello",
        approved: true,
        room: publicRoom(this.roomState, { playerId, isHost: playerId === this.roomState.hostId }),
        card: this.privateCardFor(playerId),
        token: this.tokens[playerId]?.at(-1)?.token ?? "",
      });
      // N005：挑战弃牌揭示在断线/重连后重放（私密事件，带稳定 eventId）。
      this.resendChallengeReveal(server, playerId);
      // 头像不进入 room JSON；重连时按当前查看权限用二进制帧单独重放。
      await this.sendVisibleAvatars(server, attachment);
      // 目标玩家只收到一次状态（hello 已含 room），广播排除自己（B027）。
      this.broadcastRoom(undefined, playerId);
    } else {
      safeSend(server, { type: "hello", approved: false });
    }
    await this.syncAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment<WsAttachment>();
    if (!attachment) return;
    if (message instanceof ArrayBuffer) {
      await this.handleAvatarMessage(ws, attachment, message);
      return;
    }
    if (typeof message !== "string" || new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (payload.type === "pong") return;
    // 严格协议：所有业务操作必须是 { type: "command", id, command } 信封（B020）。
    if (payload.type !== "command" || typeof payload.id !== "string" || !payload.command || typeof payload.command !== "object") {
      return;
    }
    const command = payload.command as Record<string, unknown>;
    const commandId = payload.id;
    if (attachment.pending) {
      // 待审批玩家可立即取消加入，无需等待 TTL（P1-01）。
      if (command.type === "cancel-join" || command.type === "leave") {
        await this.cancelPendingJoin(ws, commandId, attachment.playerId);
      }
      return;
    }

    // 消息频率限制：滑动窗口内超限直接断开。
    const now = Date.now();
    const windowState = now - attachment.commandWindowStartedAt > COMMAND_RATE_WINDOW_MS
      ? { commandWindowStartedAt: now, commandCount: 0 }
      : { commandWindowStartedAt: attachment.commandWindowStartedAt, commandCount: attachment.commandCount };
    if (windowState.commandCount >= COMMAND_RATE_LIMIT) {
      safeSend(ws, { type: "kicked", reason: "操作过于频繁，请稍后再试" });
      try {
        ws.close(TIMEOUT_CLOSE_CODE, "rate limited");
      } catch {
        // Already closing.
      }
      return;
    }
    ws.serializeAttachment({ ...attachment, ...windowState, commandCount: windowState.commandCount + 1 });

    await this.loadData();
    if (!this.roomState) return;
    const player = this.roomState.players.find((item) => item.id === attachment.playerId);
    if (!player) return;
    const isHost = player.id === this.roomState.hostId;
    const playerId = player.id;
    const gameId = this.roomState.gameId;

    switch (command.type) {
      case "enter-game": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        const requestedGameId = command.gameId;
        if (typeof requestedGameId !== "string" || !GAME_LIST.some((item) => item.id === requestedGameId)) {
          this.ackInvalid(ws, commandId);
          return;
        }
        let sendCards = false;
        await this.commit(ws, commandId, (state) => {
          if (state.phase !== "LOBBY" || state.gameId) return { state, changed: false };
          const result = enterGame(state, requestedGameId as GameId, Math.random);
          if (result.state === state) return { state, changed: false };
          sendCards = result.sendCards;
          return {
            state: {
              ...result.state,
              players: result.state.players.map((item) => ({ ...item, joinNextRound: false })),
            },
            changed: true,
          };
        });
        if (sendCards) this.sendCards();
        return;
      }
      case "undercover-start": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          const definition = GAME_LIST.find((item) => item.id === "undercover");
          if (game.phase !== "SETUP" || !definition || state.players.length < definition.minPlayers) {
            return { state, changed: false };
          }
          const result = startUndercoverRound(game, state.players, Math.random);
          return {
            state: {
              ...state,
              gameState: result.state,
              players: state.players.map((item) => ({ ...item, joinNextRound: false })),
            },
            changed: true,
          };
        });
        this.sendCards();
        return;
      }
      case "back-to-lobby": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const next = backToLobby(state);
          return {
            state: next,
            changed: next.phase !== state.phase || next.gameId !== state.gameId,
          };
        });
        return;
      }
      case "host-temporary-leave": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const next = hostToLobby(state);
          return { state: next, changed: next !== state && !state.hostInLobby };
        });
        return;
      }
      case "host-return-game": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          if (!state.hostInLobby || state.phase !== "GAME") return { state, changed: false };
          const next = hostReturnToGame(state);
          return { state: next, changed: true };
        });
        this.sendCards();
        return;
      }
      case "undercover-settings": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        if (!command.settings || typeof command.settings !== "object") {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          const settings = sanitizeUndercoverSettings(
            command.settings as Partial<UndercoverSettings> | undefined,
            game.settings,
            state.players.length,
          );
          if (JSON.stringify(settings) === JSON.stringify(game.settings)) return { state, changed: false };
          return { state: { ...state, gameState: { ...game, settings } }, changed: true };
        });
        return;
      }
      case "vote-ready": {
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        if (typeof command.ready !== "boolean") {
          this.ackInvalid(ws, commandId);
          return;
        }
        const ready = command.ready;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          const result = applyVoteReady(game, state.players, playerId, ready);
          const next = result.state;
          const changed = next.phase !== game.phase
            || !sameStringList(next.voteReadyPlayerIds, game.voteReadyPlayerIds)
            || next.voteResult !== game.voteResult;
          if (!changed) return { state, changed: false };
          return { state: { ...state, gameState: next }, changed };
        });
        return;
      }
      case "vote": {
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        const targetId = command.targetId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          const result = applyVote(game, state.players, playerId, targetId);
          if (result.state === game) return { state, changed: false };
          let next = result.state;
          if (result.done) {
            next = resolveUndercoverVote({ ...state, gameState: next }, Math.random).state.gameState as UndercoverState;
          }
          return { state: { ...state, gameState: next }, changed: true };
        });
        return;
      }
      case "next-round-ready": {
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        if (typeof command.ready !== "boolean") {
          this.ackInvalid(ws, commandId);
          return;
        }
        let started = false;
        const ready = command.ready;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          const result = applyNextRoundReady(game, state.players, playerId, ready, Math.random);
          const next = result.state;
          const changed = next.phase !== game.phase
            || !sameStringList(next.nextRoundReadyPlayerIds, game.nextRoundReadyPlayerIds)
            || next.nextRoundBlocked !== game.nextRoundBlocked
            || result.started;
          if (!changed) return { state, changed: false };
          started = result.started;
          return {
            state: {
              ...state,
              gameState: next,
              players: result.started
                ? state.players.map((item) => ({ ...item, joinNextRound: false }))
                : state.players,
            },
            changed: true,
          };
        });
        if (started) this.sendCards();
        return;
      }
      case "restart-game": {
        // 普通玩家不得通过遗留命令改变游戏状态（P0-03）。
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "undercover" || !this.roomState.gameState) return;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as UndercoverState;
          if (!game.winner) return { state, changed: false };
          const next = backToLobby(state);
          return { state: next, changed: true };
        });
        return;
      }
      case "challenge-settings": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        if (!command.settings || typeof command.settings !== "object") {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const settings = sanitizeChallengeSettings(command.settings as Partial<ChallengeSettings> | undefined, game.settings);
          if (JSON.stringify(settings) === JSON.stringify(game.settings)) return { state, changed: false };
          return { state: { ...state, gameState: { ...game, settings } }, changed: true };
        });
        return;
      }
      case "challenge-penalize": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const result = applyChallengePenalize(game, state.players, playerId, targetId);
          if (result.state === game) return { state, changed: false };
          const reveals = result.state.pendingReveals[targetId] ?? [];
          const reveal = reveals[reveals.length - 1];
          return {
            state: { ...state, gameState: result.state },
            changed: true,
            event: { game: "challenge", kind: "penalize", playerId: targetId },
            // 弃牌内容只发给被惩罚玩家（B002/B015），eventId 稳定用于重连重放（N005）。
            privateEvents: reveal
              ? [{ playerId: targetId, message: { type: "challenge-lost-card", eventId: reveal.eventId, action: reveal.action } }]
              : [],
          };
        });
        return;
      }
      case "challenge-lost-card-dismiss": {
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        const eventId = command.eventId;
        if (typeof eventId !== "string" || !eventId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const next = dismissChallengeLostCard(game, playerId, eventId);
          if (next === game) return { state, changed: false };
          return { state: { ...state, gameState: next }, changed: true };
        });
        return;
      }
      case "challenge-swap": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const result = applyChallengeSwap(game, state.players, targetId, Math.random);
          if (result.state === game) return { state, changed: false };
          return {
            state: { ...state, gameState: result.state },
            changed: true,
            event: { game: "challenge", kind: "swap", playerId: targetId },
          };
        });
        return;
      }
      case "challenge-reward": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const result = applyChallengeReward(game, state.players, targetId, Math.random);
          if (result.state === game) return { state, changed: false };
          return {
            state: { ...state, gameState: result.state },
            changed: true,
            event: { game: "challenge", kind: "reward", playerId: targetId },
          };
        });
        return;
      }
      case "challenge-start": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          const definition = GAME_LIST.find((item) => item.id === "challenge");
          if (game.phase !== "SETUP" || !definition || state.players.length < definition.minPlayers) {
            return { state, changed: false };
          }
          const result = startChallengeRound(game, state.players, Math.random);
          return {
            state: {
              ...state,
              gameState: result.state,
              players: state.players.map((item) => ({ ...item, joinNextRound: false })),
            },
            changed: true,
          };
        });
        this.sendCards();
        return;
      }
      case "challenge-restart": {
        // 非房主不得重启挑战（N006）。
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        if (gameId !== "challenge" || !this.roomState.gameState) return;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as ChallengeState;
          if (game.phase !== "ENDED") return { state, changed: false };
          return {
            state: {
              ...state,
              gameState: restartChallenge(game, state.players, Math.random),
              players: state.players.map((item) => ({ ...item, joinNextRound: false })),
            },
            changed: true,
          };
        });
        this.sendCards();
        return;
      }
      case "mahjong-transfer": {
        if (gameId !== "mahjong" || !this.roomState.gameState) return;
        const targetId = command.targetId;
        const points = command.points;
        const operationId = command.operationId;
        if (typeof targetId !== "string" || !targetId
          || typeof points !== "number" || !Number.isInteger(points) || points < 1 || points > 99999
          || typeof operationId !== "string" || operationId.length < 8 || operationId.length > 64) {
          this.ackInvalid(ws, commandId);
          return;
        }
        // 幂等去重：同一 operationId 只计一次分（P0-04）。
        const previous = (this.processedTransfers[playerId] ?? []).find((item) => item.operationId === operationId);
        if (previous) {
          if (previous.targetId !== targetId || previous.points !== points) {
            this.ackConflict(ws, commandId);
            return;
          }
          safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision, duplicate: true });
          return;
        }
        const game = this.roomState.gameState as MahjongState;
        const result = applyMahjongTransfer(game, this.roomState.players, playerId, targetId, points);
        if (!result.applied) {
          this.ackInvalid(ws, commandId);
          return;
        }
        // 房间状态 + 幂等记录一次落盘，避免“已计分但未记录”的窗口。
        this.roomState = {
          ...this.roomState,
          revision: this.roomState.revision + 1,
          gameState: result.state,
        };
        this.recordProcessedTransfer(playerId, operationId, targetId, points, this.roomState.revision);
        await this.persist();
        this.broadcastRoom();
        safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
        return;
      }
      case "mahjong-collect": {
        if (gameId !== "mahjong" || !this.roomState.gameState) return;
        const collectPoints = command.points;
        const collectOperationId = command.operationId;
        if (typeof collectPoints !== "number" || !Number.isInteger(collectPoints) || collectPoints < 1 || collectPoints > 99999
          || typeof collectOperationId !== "string" || collectOperationId.length < 8 || collectOperationId.length > 64) {
          this.ackInvalid(ws, commandId);
          return;
        }
        // 幂等：同一 operationId 只创建一个待确认条目（重试返回重复成功）。
        const collectPrevious = (this.processedTransfers[playerId] ?? []).find((item) => item.operationId === collectOperationId);
        if (collectPrevious) {
          safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision, duplicate: true });
          return;
        }
        const collectResult = applyMahjongCollect(this.roomState.gameState as MahjongState, this.roomState.players, playerId, collectPoints, collectOperationId);
        if (!collectResult.applied) {
          this.ackInvalid(ws, commandId);
          return;
        }
        this.roomState = {
          ...this.roomState,
          revision: this.roomState.revision + 1,
          gameState: collectResult.state,
        };
        this.recordProcessedTransfer(playerId, collectOperationId, "", collectPoints, this.roomState.revision);
        await this.persist();
        this.broadcastRoom();
        safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
        return;
      }
      case "mahjong-collect-vote": {
        if (gameId !== "mahjong" || !this.roomState.gameState) return;
        const collectId = command.collectId;
        const approve = command.approve;
        if (typeof collectId !== "string" || !collectId || typeof approve !== "boolean") {
          this.ackInvalid(ws, commandId);
          return;
        }
        const collectBefore = (this.roomState.gameState as MahjongState).pendingCollects.find((item) => item.id === collectId);
        const voteResult = applyMahjongCollectVote(this.roomState.gameState as MahjongState, this.roomState.players, collectId, playerId, approve);
        if (!voteResult.applied) {
          this.ackInvalid(ws, commandId);
          return;
        }
        this.roomState = {
          ...this.roomState,
          revision: this.roomState.revision + 1,
          gameState: voteResult.state,
        };
        await this.persist();
        this.broadcastRoom();
        // 被否决时给发起者单独推送红色提示事件。
        if (!approve && collectBefore) {
          const voterName = this.roomState.players.find((player) => player.id === playerId)?.name ?? "";
          for (const socket of this.ctx.getWebSockets(`player:${collectBefore.collectorId}`)) {
            safeSend(socket, { type: "mahjong-collect-rejected", collectId, points: collectBefore.points, voterName });
          }
        }
        safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
        return;
      }
      case "mahjong-reset-ready": {
        if (gameId !== "mahjong" || !this.roomState.gameState) return;
        if (typeof command.ready !== "boolean") {
          this.ackInvalid(ws, commandId);
          return;
        }
        const ready = command.ready;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as MahjongState;
          const result = applyMahjongResetReady(game, state.players, playerId, ready);
          const next = result.state;
          const changed = result.reset
            || !sameStringList(next.resetReadyPlayerIds, game.resetReadyPlayerIds)
            || next.settleReadyPlayerIds.length !== game.settleReadyPlayerIds.length;
          if (!changed) return { state, changed: false };
          return {
            state: {
              ...state,
              gameState: next,
              players: result.reset ? state.players.map((item) => ({ ...item, joinNextRound: false })) : state.players,
            },
            changed: true,
          };
        });
        return;
      }
      case "mahjong-settle-ready": {
        if (gameId !== "mahjong" || !this.roomState.gameState) return;
        if (typeof command.ready !== "boolean") {
          this.ackInvalid(ws, commandId);
          return;
        }
        const ready = command.ready;
        await this.commit(ws, commandId, (state) => {
          const game = state.gameState as MahjongState;
          const result = applyMahjongSettleReady(game, state.players, playerId, ready);
          const next = result.state;
          const changed = result.settled
            || !sameStringList(next.settleReadyPlayerIds, game.settleReadyPlayerIds)
            || next.resetReadyPlayerIds.length !== game.resetReadyPlayerIds.length;
          if (!changed) return { state, changed: false };
          return { state: { ...state, gameState: next }, changed: true };
        });
        return;
      }
      case "approve-join": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        const targetSocket = this.socketForPlayer(targetId, true);
        const result = approveJoinRequest(this.roomState, targetId, Boolean(targetSocket));
        if (!result.request || result.state === this.roomState) {
          this.ackInvalid(ws, commandId);
          return;
        }
        let next = result.state;
        if (next.phase === "GAME") {
          if (next.gameId === "mahjong" && next.gameState) {
            const approvedPlayer = next.players.find((item) => item.id === targetId);
            const game = next.gameState as MahjongState;
            next = {
              ...next,
              gameState: approvedPlayer ? addMahjongPlayer(game, approvedPlayer) : game,
            };
          } else {
            next = {
              ...next,
              players: next.players.map((item) =>
                item.id === targetId ? { ...item, joinNextRound: true } : item),
            };
          }
        }
        // 批准作为单个事务：房间状态 + 新凭证一次落盘（P1-02）。
        const issuedToken = crypto.randomUUID();
        const previous = this.tokens[targetId] ?? [];
        this.roomState = { ...next, revision: this.roomState.revision + 1 };
        this.tokens[targetId] = [
          ...previous.map((record) => ({
            ...record,
            expiresAt: record.kind === "join-request" ? Date.now() + TOKEN_OVERLAP_MS : record.expiresAt,
          })),
          { token: issuedToken, kind: "member", issuedAt: Date.now(), expiresAt: null },
        ];
        this.syncAllOfflineState();
        await this.persist();
        this.broadcastRoom({ game: "room", kind: "join-approved", playerId: targetId });
        if (targetSocket) {
          const previousAttachment = targetSocket.deserializeAttachment<WsAttachment>();
          targetSocket.serializeAttachment({
            ...(previousAttachment ?? {
              playerId: targetId,
              pending: false,
              connectedAt: Date.now(),
              commandWindowStartedAt: Date.now(),
              commandCount: 0,
            }),
            pending: false,
          });
          safeSend(targetSocket, {
            type: "approved",
            room: publicRoom(this.roomState, { playerId: targetId, isHost: false }),
            card: this.privateCardFor(targetId),
            token: issuedToken,
          });
          this.resendChallengeReveal(targetSocket, targetId);
          await this.sendVisibleAvatars(targetSocket, {
            ...(previousAttachment ?? {
              playerId: targetId,
              pending: false,
              connectedAt: Date.now(),
              commandWindowStartedAt: Date.now(),
              commandCount: 0,
            }),
            pending: false,
          });
        }
        // 申请阶段头像只给房主；批准后才把该玩家头像发给所有正式成员。
        await this.broadcastStoredAvatar(targetId, targetSocket ?? undefined);
        // ACK 在凭证落盘与目标 attachment 更新之后返回。
        safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
        return;
      }
      case "reject-join": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        let rejected = false;
        await this.commit(ws, commandId, (state) => {
          const exists = state.pendingJoinRequests.some((item) => item.id === targetId);
          if (!exists) return { state, changed: false };
          rejected = true;
          return { state: rejectJoinRequest(state, targetId), changed: true };
        });
        if (rejected) {
          delete this.tokens[targetId];
          await this.deleteAvatar(targetId);
          await this.persist();
          const targetSocket = this.socketForPlayer(targetId, true);
          if (targetSocket) {
            safeSend(targetSocket, { type: "rejected", reason: "房主拒绝了加入申请" });
            try {
              targetSocket.close(1000, "rejected");
            } catch {
              // Already closing.
            }
          }
        }
        return;
      }
      case "kick": {
        if (!isHost) {
          this.ackForbidden(ws, commandId);
          return;
        }
        const targetId = command.playerId;
        if (typeof targetId !== "string" || !targetId) {
          this.ackInvalid(ws, commandId);
          return;
        }
        if (targetId === playerId) return;
        let removedPlayer: Player | null = null;
        let sendCards = false;
        await this.commit(ws, commandId, (state) => {
          const exists = state.players.some((item) => item.id === targetId);
          if (!exists) return { state, changed: false };
          removedPlayer = state.players.find((item) => item.id === targetId) ?? null;
          const afterKick = kickPlayer(state, targetId);
          const settled = settleAfterRemoval(afterKick, Math.random, removedPlayer);
          sendCards = settled.sendCards;
          return { state: settled.state, changed: true };
        });
        if (removedPlayer) {
          this.syncAllOfflineState();
          delete this.tokens[targetId];
          await this.deleteAvatar(targetId);
          await this.persist();
          // 踢出时关闭该玩家全部连接（B011）。
          for (const targetSocket of this.ctx.getWebSockets(`player:${targetId}`)) {
            safeSend(targetSocket, { type: "kicked", reason: "你已被房主移出房间" });
            try {
              targetSocket.close(KICKED_CLOSE_CODE, "你已被房主移出房间");
            } catch {
              // Already closing.
            }
          }
          if (sendCards) this.sendCards();
          await this.syncAlarm();
        }
        return;
      }
      case "leave": {
        if (player.id === this.roomState.hostId) {
          // 房主离开会销毁整个房间，但仍要先确认当前 leave 命令。
          // 否则客户端会一直等待 ACK，直到命令超时后才清理本地会话。
          safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
          await this.closeRoom("房主已离开，房间已关闭", ws);
          return;
        }
        await this.commit(ws, commandId, (state) => {
          const afterKick = kickPlayer(state, playerId);
          const settled = settleAfterRemoval(afterKick, Math.random, player);
          return { state: settled.state, changed: true };
        });
        this.syncAllOfflineState();
        delete this.tokens[playerId];
        await this.deleteAvatar(playerId);
        await this.persist();
        safeSend(ws, { type: "left" });
        try {
          ws.close(1000, "leave");
        } catch {
          // Already closing.
        }
        await this.syncAlarm();
        return;
      }
      default:
        return;
    }
  }

  /** 严格协议校验失败时的统一 ACK（N007）。 */
  private ackInvalid(ws: WorkerWebSocket, commandId: string) {
    safeSend(ws, { type: "ack", id: commandId, ok: false, error: "INVALID", revision: this.roomState?.revision ?? 0 });
  }

  /** 权限不足时的 ACK（P0-03）。 */
  private ackForbidden(ws: WorkerWebSocket, commandId: string) {
    safeSend(ws, { type: "ack", id: commandId, ok: false, error: "FORBIDDEN", revision: this.roomState?.revision ?? 0 });
  }

  /** 幂等冲突（同一 operationId 携带不同 payload）时的 ACK（P0-04）。 */
  private ackConflict(ws: WorkerWebSocket, commandId: string) {
    safeSend(ws, { type: "ack", id: commandId, ok: false, error: "CONFLICT", revision: this.roomState?.revision ?? 0 });
  }

  /** 待审批玩家取消加入：清理申请、token、连接与 Alarm（P1-01）。 */
  private async cancelPendingJoin(ws: WorkerWebSocket, commandId: string, playerId: string) {
    await this.loadData();
    const stillPending = this.roomState?.pendingJoinRequests.some((item) => item.id === playerId) ?? false;
    if (this.roomState && stillPending) {
      this.roomState = {
        ...this.roomState,
        revision: this.roomState.revision + 1,
        pendingJoinRequests: this.roomState.pendingJoinRequests.filter((item) => item.id !== playerId),
      };
      delete this.tokens[playerId];
      await this.persist();
      await this.syncAlarm();
      this.broadcastRoom();
    } else {
      delete this.tokens[playerId];
    }
    await this.deleteAvatar(playerId);
    safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState?.revision ?? 0 });
    safeSend(ws, { type: "left" });
    try {
      ws.close(1000, "join cancelled");
    } catch {
      // Already closing.
    }
  }

  /** 记录已处理的麻将转分操作（按玩家有界保存 128 条，P0-04）。 */
  private recordProcessedTransfer(
    playerId: string,
    operationId: string,
    targetId: string,
    points: number,
    revision: number,
  ) {
    const list = this.processedTransfers[playerId] ?? [];
    list.unshift({ operationId, targetId, points, revision });
    // 幂等记录保留到房间销毁（P0-04 加固）：旧 operationId 不会因记录淘汰导致重试重复计分。
    this.processedTransfers[playerId] = list;
  }

  /** 统一提交：变更才持久化/广播；成功后 ACK 并递增 revision（4.3/B008/B026）。 */
  private async commit(
    ws: WorkerWebSocket,
    commandId: string,
    mutate: (state: RoomState) => MutationResult,
  ) {
    if (!this.roomState) return;
    let result: MutationResult;
    try {
      result = mutate(this.roomState);
    } catch (error) {
      // 生产记录并拒绝提交：绝不写入不满足不变量（如麻将零和）的状态。
      console.error("[commit] rejected mutation", error);
      safeSend(ws, { type: "ack", id: commandId, ok: false, error: "INVALID", revision: this.roomState.revision });
      return;
    }
    if (!result.changed) {
      safeSend(ws, { type: "ack", id: commandId, ok: false, error: "INVALID", revision: this.roomState.revision });
      return;
    }
    this.roomState = {
      ...result.state,
      revision: this.roomState.revision + 1,
    };
    await this.persist();
    this.broadcastRoom(result.event);
    this.sendPrivateEvents(result.privateEvents ?? []);
    safeSend(ws, { type: "ack", id: commandId, ok: true, revision: this.roomState.revision });
  }

  async webSocketClose(ws: WorkerWebSocket, code: number, _reason: string, _wasClean: boolean) {
    const attachment = ws.deserializeAttachment<WsAttachment>();
    if (!attachment) return;
    if (code === KICKED_CLOSE_CODE) return;
    if (attachment.pending) return;
    await this.loadData();
    if (!this.roomState) return;
    const stillInRoom = this.roomState.players.some((player) => player.id === attachment.playerId);
    if (!stillInRoom) return;
    // 多连接：只有该玩家所有 approved socket 都关闭后才标记离线（B011）。
    const remaining = this.ctx.getWebSockets(`player:${attachment.playerId}`)
      .filter((socket) => socket !== ws)
      .filter((socket) => !socket.deserializeAttachment<WsAttachment>()?.pending);
    if (remaining.length > 0) return;
    this.roomState = {
      ...this.roomState,
      revision: this.roomState.revision + 1,
      players: this.roomState.players.map((player) =>
        player.id === attachment.playerId ? { ...player, online: false, offlineSince: Date.now() } : player),
    };
    this.syncAllOfflineState();
    await this.persist();
    this.broadcastRoom();
    await this.syncAlarm();
  }

  /**
   * Alarm 只处理真实截止时间：过期申请清理、房主离线超时、房间清空销毁，
   * 然后重新计算最近截止时间（4.5/B019）。不再做每分钟心跳。
   */
  async alarm() {
    await this.loadData();
    if (!this.roomState) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();

    const expired = this.roomState.pendingJoinRequests
      .filter((request) => now - request.createdAt >= JOIN_REQUEST_TTL_MS);
    if (expired.length > 0) {
      this.roomState = {
        ...this.roomState,
        revision: this.roomState.revision + 1,
        pendingJoinRequests: this.roomState.pendingJoinRequests
          .filter((request) => now - request.createdAt < JOIN_REQUEST_TTL_MS),
      };
      for (const request of expired) {
        // 申请过期时同时删除 token 与房间内临时头像（B007）。
        delete this.tokens[request.id];
        await this.deleteAvatar(request.id);
        const socket = this.socketForPlayer(request.id, true);
        if (socket) {
          safeSend(socket, { type: "rejected", reason: "加入申请已过期" });
          try {
            socket.close(1000, "rejected");
          } catch {
            // Already closing.
          }
        }
      }
      await this.persist();
      this.broadcastRoom();
    }

    if (this.roomState.players.length === 0) {
      await this.destroyRoom();
      return;
    }

    if (
      typeof this.roomState.allOfflineSince === "number"
      && now - this.roomState.allOfflineSince >= ALL_OFFLINE_LIMIT_MS
    ) {
      await this.closeRoom("所有玩家长时间未连接，房间已自动关闭");
      return;
    }
    const tickets = await this.loadTickets();
    this.pruneExpiredTickets(tickets, now);
    await this.saveTickets();
    await this.syncAlarm();
  }

  /** 维护“全员离线”时间戳：所有玩家离线时记录起始时间，有人上线或玩家变动时更新。 */
  private syncAllOfflineState(now = Date.now()) {
    if (!this.roomState) return;
    const allOffline = this.roomState.players.length > 0
      && this.roomState.players.every((player) => !player.online);
    if (allOffline) {
      if (typeof this.roomState.allOfflineSince !== "number") {
        this.roomState = { ...this.roomState, allOfflineSince: now };
      }
    } else if (typeof this.roomState.allOfflineSince === "number") {
      this.roomState = { ...this.roomState, allOfflineSince: undefined };
    }
  }

  private async syncAlarm() {
    if (!this.roomState) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadlines: number[] = [];
    if (typeof this.roomState.allOfflineSince === "number") {
      deadlines.push(this.roomState.allOfflineSince + ALL_OFFLINE_LIMIT_MS);
    }
    for (const request of this.roomState.pendingJoinRequests) {
      deadlines.push(request.createdAt + JOIN_REQUEST_TTL_MS);
    }
    const next = deadlines.length > 0 ? Math.min(...deadlines) : null;
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current !== next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async destroyRoom(): Promise<void> {
    this.roomState = null;
    this.tokens = {};
    this.processedTransfers = {};
    this.wsTickets = null;
    // 房间就是完整的数据生命周期边界：玩家头像缩略图、房间状态、ticket 等
    // 都只存在这个 Durable Object 中；关闭房间时一次清空，避免留下头像数据。
    await this.ctx.storage.deleteAll();
  }

  private async closeRoom(reason: string, leavingSocket?: WorkerWebSocket): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      // 房主主动 leave 时，先让发起 socket 收到 ACK，再由客户端自行 close。
      // 如果这里立即 close 同一条连接，微信真机可能在 ACK flush 前收到 close，
      // 导致客户端一直等命令确认。其它玩家仍应立即收到房间关闭通知。
      if (ws === leavingSocket) continue;
      safeSend(ws, { type: "kicked", reason });
      try {
        ws.close(KICKED_CLOSE_CODE, reason);
      } catch {
        // Connection may already be closing; room data is destroyed below.
      }
    }
    await this.destroyRoom();
  }

  private socketForPlayer(playerId: string, includePending = false): WorkerWebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment<WsAttachment>();
      if (attachment?.playerId === playerId && (includePending || !attachment.pending)) return ws;
    }
    return null;
  }

  private avatarStorageKey(playerId: string) {
    return `avatar:${playerId}`;
  }

  private async deleteAvatar(playerId: string) {
    await this.ctx.storage.delete(this.avatarStorageKey(playerId));
  }

  private async readAvatar(playerId: string): Promise<StoredAvatar | null> {
    return await this.ctx.storage.get<StoredAvatar>(this.avatarStorageKey(playerId)) ?? null;
  }

  private sendAvatar(ws: WorkerWebSocket, playerId: string, avatar: StoredAvatar) {
    const frame = encodeAvatarDeliveryFrame(playerId, avatar.mime, avatar.bytes);
    if (frame) safeSendBinary(ws, frame);
  }

  private async sendVisibleAvatars(ws: WorkerWebSocket, attachment: WsAttachment) {
    await this.loadData();
    if (!this.roomState || attachment.pending) return;
    const visibleIds = this.roomState.players.map((player) => player.id);
    if (attachment.playerId === this.roomState.hostId) {
      visibleIds.push(...this.roomState.pendingJoinRequests.map((request) => request.id));
    }
    for (const playerId of visibleIds) {
      const avatar = await this.readAvatar(playerId);
      if (avatar) this.sendAvatar(ws, playerId, avatar);
    }
  }

  private async broadcastStoredAvatar(playerId: string, excludeSocket?: WorkerWebSocket) {
    const avatar = await this.readAvatar(playerId);
    if (!avatar) return;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludeSocket) continue;
      const attachment = socket.deserializeAttachment<WsAttachment>();
      if (!attachment || attachment.pending) continue;
      this.sendAvatar(socket, playerId, avatar);
    }
  }

  private async handleAvatarMessage(ws: WorkerWebSocket, attachment: WsAttachment, frame: ArrayBuffer) {
    const decoded = decodeAvatarUploadFrame(frame);
    if (!decoded) return;
    const now = Date.now();
    if (attachment.avatarUpdatedAt && now - attachment.avatarUpdatedAt < 1_500) return;

    await this.loadData();
    if (!this.roomState) return;
    const isPlayer = this.roomState.players.some((player) => player.id === attachment.playerId);
    const isPending = !isPlayer && this.roomState.pendingJoinRequests.some((request) => request.id === attachment.playerId);
    if (!isPlayer && !isPending) return;

    ws.serializeAttachment({ ...attachment, pending: isPending, avatarUpdatedAt: now });
    const avatar: StoredAvatar = { mime: decoded.mime, bytes: decoded.bytes };
    await this.ctx.storage.put(this.avatarStorageKey(attachment.playerId), avatar);

    if (isPending) {
      for (const hostSocket of this.ctx.getWebSockets(`player:${this.roomState.hostId}`)) {
        if (hostSocket === ws) continue;
        const hostAttachment = hostSocket.deserializeAttachment<WsAttachment>();
        if (!hostAttachment || hostAttachment.pending) continue;
        this.sendAvatar(hostSocket, attachment.playerId, avatar);
      }
      return;
    }
    await this.broadcastStoredAvatar(attachment.playerId, ws);
  }

  /** 断线重连后重放未确认的挑战弃牌揭示队列（N005）。 */
  private resendChallengeReveal(ws: WorkerWebSocket, playerId: string) {
    const room = this.roomState;
    if (!room?.gameState || room.gameId !== "challenge") return;
    const reveals = (room.gameState as ChallengeState).pendingReveals[playerId] ?? [];
    for (const reveal of reveals) {
      safeSend(ws, { type: "challenge-lost-card", eventId: reveal.eventId, action: reveal.action });
    }
  }

  /** 当前游戏中，某位玩家自己的私密内容（牌面/禁忌动作）。 */
  private privateCardFor(playerId: string): unknown {
    const room = this.roomState;
    if (!room?.gameState) return null;
    if (room.gameId === "undercover") {
      return (room.gameState as UndercoverState).cards[playerId] ?? null;
    }
    return null;
  }

  private sendCards() {
    const room = this.roomState;
    if (!room?.gameState) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment<WsAttachment>();
      if (!attachment || attachment.pending) continue;
      const card = this.privateCardFor(attachment.playerId);
      if (card) safeSend(ws, { type: "card", game: room.gameId, card });
    }
  }

  private sendPrivateEvents(events: Array<{ playerId: string; message: unknown }>) {
    for (const { playerId, message } of events) {
      for (const ws of this.ctx.getWebSockets(`player:${playerId}`)) {
        const attachment = ws.deserializeAttachment<WsAttachment>();
        if (!attachment || attachment.pending) continue;
        safeSend(ws, message);
      }
    }
  }

  private broadcastRoom(event?: RoomEvent, excludePlayerId?: string) {
    if (!this.roomState) return;
    // 不能用 getWebSockets("approved")：WebSocket tag 在 accept 后不可改写，
    // 批准时只更新 attachment.pending，因此按全部 socket + pending 过滤（N001）。
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment<WsAttachment>();
      // 待审批连接绝不接收房间广播（B003）。
      if (!attachment || attachment.pending) continue;
      if (excludePlayerId && attachment.playerId === excludePlayerId) continue;
      const viewer: Viewer = {
        playerId: attachment.playerId,
        isHost: attachment.playerId === this.roomState!.hostId,
      };
      const room = publicRoom(this.roomState, viewer);
      safeSend(ws, { type: "room", room, ...(event ? { event } : {}) });
    }
  }
}