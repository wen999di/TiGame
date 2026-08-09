"use client";

import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { createPortal } from "@tigame/portal";
import { ActionButton, ActionForm } from "@tigame/form-controls";
import { MiniQrCode } from "@tigame/mini-qr";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from "motion/react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { GAME_LIST, ROOM_MAX_PLAYERS, type GameId, type PendingJoinRequest, type Player, type PublicRoom } from "./game/room";
import { ROOM_ID_PATTERN, normalizeRoomId } from "./game/room-id";
import { type SecretCard, type UndercoverPublicState, type UndercoverSettings } from "./game/undercover";
import { type WordBankScope } from "./game/deal-cards";
import { type ChallengePublicState, type ChallengeSettings } from "./game/challenge";
import { type MahjongPublicState } from "./game/mahjong";
import { MahjongHistory } from "@tigame/mahjong-history";
import { MahjongSendTrace } from "@tigame/mahjong-send-trace";
import { FlipText } from "./components/FlipText";

type Screen = "home" | "create" | "join" | "lobby" | "game";

type Room = PublicRoom & {
  localPlayerId: string;
};

type StoredSession = {
  roomId: string;
  playerId: string;
  token: string;
  playerName: string;
};

type PrivateCard = SecretCard | { action: string };

type TiGameUserProfile = {
  nickname: string;
  avatarData?: string;
};

type TiGamePlatformBridge = {
  kind?: "weapp" | "web";
  apiBase?: string;
  webBase?: string;
  getInviteCode?: () => string;
  getUserProfile?: () => TiGameUserProfile | null;
  ensureUserProfile?: () => Promise<TiGameUserProfile | null>;
  clearInviteCode?: () => void;
  scanCode?: () => Promise<string>;
  setShareRoomId?: (roomId: string) => void;
};

function getPlatformBridge(): TiGamePlatformBridge | undefined {
  return (globalThis as typeof globalThis & { __TIGAME_PLATFORM__?: TiGamePlatformBridge }).__TIGAME_PLATFORM__;
}

// 确认加入时，从申请列表“飞向”玩家列表的头像。
type JoinFlight = {
  id: string;
  name: string;
  avatarData?: string;
  key: number;
  from: { x: number; y: number };
  to: { x: number; y: number } | null;
  color: string | null;
};

type CommandAckMessage = {
  type: "ack";
  id: string;
  ok: boolean;
  revision?: number;
  error?: "INVALID" | "FORBIDDEN" | "CONFLICT" | "OFFLINE";
  duplicate?: boolean;
};

type ServerMessage =
  | { type: "hello"; approved: boolean; room?: PublicRoom; card?: PrivateCard | null; token?: string }
  | { type: "room"; room: PublicRoom; event?: { game: string; kind: string; playerId: string } }
  | { type: "card"; game: GameId; card: PrivateCard }
  | { type: "approved"; room: PublicRoom; card?: PrivateCard | null; token?: string }
  | { type: "rejected"; reason?: string }
  | { type: "kicked"; reason?: string }
  | { type: "left" }
  | { type: "challenge-lost-card"; eventId: string; action: string }
  | { type: "mahjong-collect-rejected"; collectId: string; points: number; voterName: string }
  | CommandAckMessage
  | { type: "ping" };

const SESSION_STORAGE_KEY = "who-is-undercover:session";
const NICKNAME_STORAGE_KEY = "who-is-undercover:nickname";

/** 全局动效 token：页面/步骤/弹层/Toast/列表统一时长（4.8）。 */
const MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const motionTokens = {
  screen: { duration: 0.32, ease: MOTION_EASE },
  step: { duration: 0.26, ease: MOTION_EASE },
  overlay: { duration: 0.22, ease: MOTION_EASE },
  toast: { duration: 0.2, ease: MOTION_EASE },
  layout: { duration: 0.3, ease: MOTION_EASE },
};

/** 重连退避：只在连接稳定后重置计数（B004）。 */
const RECONNECT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function nextReconnectDelay(attempt: number) {
  const base = RECONNECT_BACKOFF[Math.min(attempt, RECONNECT_BACKOFF.length - 1)];
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** 命令 ID：优先 crypto.randomUUID，非安全上下文/旧浏览器回退到随机十六进制（避免 randomUUID is not a function）。 */
function newUuid(): string {
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
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16))}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function randomId(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function makeRoomId() {
  return `${randomId(3)}-${randomId(3)}`;
}

function makeInviteUrl(room: Room) {
  const platformBase = getPlatformBridge()?.webBase?.replace(/\/$/, "");
  if (platformBase) return `${platformBase}/?invite=${room.roomId}`;
  if (typeof window === "undefined") return `https://example.com/?invite=${room.roomId}`;
  const base = window.location.pathname.replace(/\/?$/, "/");
  return `${window.location.origin}${base}?invite=${room.roomId}`;
}

function extractInviteCode(value: string) {
  const match = value.match(/[?&]invite=([A-Za-z0-9-]+)/i);
  return match?.[1] ?? value;
}

/** 通过认证 HTTP 换取 30 秒单次使用的 WebSocket ticket，URL 不再携带长期 token（B021）。 */
async function fetchWsTicket(session: StoredSession): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/ws-ticket?roomId=${encodeURIComponent(session.roomId)}&playerId=${encodeURIComponent(session.playerId)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { ticket?: string };
    return payload.ticket ?? null;
  } catch {
    return null;
  }
}

/** 麻将分数统一解析：移动键盘、桌面输入与按钮 disabled 使用同一个验证结果（F007/F091/F092）。 */
function parseMahjongPoints(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d{1,5}$/.test(raw)) {
    return { ok: false, error: "请输入 1–99999 的整数" };
  }
  const value = Number(raw);
  if (value < 1 || value > 99999) {
    return { ok: false, error: "分数范围为 1–99999" };
  }
  return { ok: true, value };
}

type CommandResult =
  | { status: "confirmed"; revision?: number; duplicate?: boolean }
  | { status: "rejected"; error: "INVALID" | "FORBIDDEN" | "CONFLICT" | "OFFLINE" }
  | { status: "unknown"; reason: "TIMEOUT" | "DISCONNECTED" | "SEND_FAILED" };

/** 转分发送持久化 outbox：先落本地存储再发送，刷新/系统回收后可恢复（P0-04 加固）。 */
type PersistedTransfer = {
  roomId: string;
  playerId: string;
  operationId: string;
  targetId: string;
  targetName: string;
  points: number;
};

const TRANSFER_OUTBOX_KEY = "tigame:transfer-outbox";
// 结果未知时的自动重试退避：立即、1s、2s、4s、8s、15s、30s、60s，封顶 60s。
const TRANSFER_RETRY_BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

function readTransferOutbox(): PersistedTransfer[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(TRANSFER_OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PersistedTransfer =>
        Boolean(item) && typeof item === "object" &&
        typeof (item as PersistedTransfer).operationId === "string" &&
        typeof (item as PersistedTransfer).targetId === "string" &&
        typeof (item as PersistedTransfer).points === "number",
    );
  } catch {
    return [];
  }
}

function writeTransferOutbox(entries: PersistedTransfer[]) {
  if (typeof localStorage === "undefined") return;
  try {
    if (entries.length === 0) localStorage.removeItem(TRANSFER_OUTBOX_KEY);
    else localStorage.setItem(TRANSFER_OUTBOX_KEY, JSON.stringify(entries));
  } catch {
    // 存储不可用（隐私模式等）时仍按内存状态继续发送。
  }
}

function saveTransferToOutbox(entry: PersistedTransfer) {
  const entries = readTransferOutbox();
  writeTransferOutbox([...entries.filter((item) => item.operationId !== entry.operationId), entry]);
}

function removeTransferFromOutbox(operationId: string) {
  writeTransferOutbox(readTransferOutbox().filter((item) => item.operationId !== operationId));
}

type ReconnectPhase = "idle" | "retrying" | "waiting-network" | "syncing";

/** 连接状态胶囊文案：区分同步中/等待网络/重连中。 */
function connectionLabel(wsStatus: "closed" | "connecting" | "open", reconnectPhase: ReconnectPhase): string {
  if (wsStatus === "open") return "已连接";
  if (reconnectPhase === "syncing") return "正在同步…";
  if (reconnectPhase === "waiting-network") return "等待网络恢复";
  return "重连中…";
}

/**
 * 向云端确认房间与会话是否仍有效（按状态码区分）：
 * alive=房间在且是成员；member-gone=已不在房间；room-gone=房间不存在(404/410)；
 * auth-gone=凭证失效(401/403)；unknown=暂时无法确认(429/5xx/网络错误)。
 */
async function probeRoomStatus(
  session: StoredSession,
): Promise<"alive" | "member-gone" | "room-gone" | "auth-gone" | "unknown"> {
  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(session.roomId)}?playerId=${encodeURIComponent(session.playerId)}`,
      { cache: "no-store", headers: { authorization: `Bearer ${session.token}` } },
    );
    if (response.ok) {
      const info = await response.json().catch(() => null) as { member?: boolean } | null;
      if (info && info.member === false) return "member-gone";
      return "alive";
    }
    if (response.status === 404 || response.status === 410) return "room-gone";
    if (response.status === 401 || response.status === 403) return "auth-gone";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// 部分移动端浏览器会禁用 navigator.clipboard，降级到隐藏 textarea + execCommand。
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试 execCommand 降级方案。
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

async function apiError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!value) return null;
    const session = JSON.parse(value) as StoredSession;
    if (!session.roomId || !session.playerId || !session.token) return null;
    return session;
  } catch {
    return null;
  }
}

function storeSession(session: StoredSession) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // 隐私模式或存储不可用时忽略：会话仍保留在内存中，当前页面内可重连。
    }
  }
}

function sameSession(a: StoredSession | null, b: StoredSession | null) {
  return Boolean(
    a
    && b
    && a.roomId === b.roomId
    && a.playerId === b.playerId
    && a.token === b.token,
  );
}

function clearStoredSession() {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}

function readStoredNickname() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NICKNAME_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function storeNickname(name: string) {
  if (typeof window === "undefined" || !name) return;
  try {
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, name);
  } catch {
    // Ignore storage errors.
  }
}

function avatarFace(name: string, avatarData?: string) {
  return avatarData
    ? <img className="avatar-image" src={avatarData} alt="" draggable={false} />
    : name.slice(0, 1);
}

function playerNames(players: readonly Player[], playerIds: readonly string[]) {
  const names = playerIds.map((playerId) => players.find((player) => player.id === playerId)?.name ?? "未知玩家");
  return names.length > 0 ? names.join("、") : "无";
}


const ROLLER_ITEM_WIDTH = 40;
const ROLLER_CONTAINER_WIDTH = 152;
const ROLLER_PAD = (ROLLER_CONTAINER_WIDTH - ROLLER_ITEM_WIDTH) / 2;

type RollerPhase = "idle" | "dragging" | "settling";

interface RollerDragState {
  pointerId: number;
  pointerType: string;

  startX: number;
  startOffset: number;

  lastX: number;
  lastTime: number;
  velocity: number;

  moved: boolean;
}

interface UndercoverRollerProps {
  value: number;
  max: number | null;
  onChange: (value: number) => void;
  ariaLabel?: string;
  /** 真正的禁用：禁止 Pointer/Keyboard/focus 与确认动画（F001）。 */
  disabled?: boolean;
}

/**
 * 左右拖动选择数字的滚轮。
 *
 * 功能：
 * - 点击数字直接选择
 * - 横向拖动选择
 * - max 为 null 时可无限选择更大的数字
 * - 拖动时实时高亮中心数字
 * - 松手时弹性吸附并播放确认动画
 * - 支持键盘方向键、Home、End
 * - 支持鼠标、触摸屏和触控笔
 */
function UndercoverRoller({
  value,
  max,
  onChange,
  ariaLabel = "数字选择器",
  disabled = false,
}: UndercoverRollerProps) {
  const normalizeValue = useCallback((nextValue: number) => {
    const rounded = Math.round(nextValue);

    if (max === null) {
      return Math.max(1, rounded);
    }

    return Math.max(1, Math.min(max, rounded));
  }, [max]);

  const valueToOffset = useCallback((nextValue: number) => {
    const normalized = normalizeValue(nextValue);

    return (
      ROLLER_PAD -
      (normalized - 1) * ROLLER_ITEM_WIDTH
    );
  }, [normalizeValue]);

  const [offset, setOffset] = useState(() =>
    valueToOffset(value),
  );

  /**
   * previewValue 表示当前视觉上位于中央的数字。
   *
   * 它与外部 value 分离，因此拖动过程中可以实时变化，
   * 不必等待 onChange 和服务器状态更新。
   */
  const [previewValue, setPreviewValue] = useState(() =>
    normalizeValue(value),
  );

  const [phase, setPhase] =
    useState<RollerPhase>("idle");

  const [confirming, setConfirming] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<RollerDragState | null>(null);

  const settleTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const confirmFrameRef = useRef<number | null>(null);

  /**
   * 有上限模式下，轨道允许到达的最左位置。
   */
  const minimumOffset =
    max === null
      ? Number.NEGATIVE_INFINITY
      : ROLLER_PAD -
        (max - 1) * ROLLER_ITEM_WIDTH;

  /**
   * 将位置严格限制在合法范围。
   *
   * 最终吸附时使用，确保轨道不会停在边界之外。
   */
  const clampOffset = (nextOffset: number) => {
    const upperBounded = Math.min(
      ROLLER_PAD,
      nextOffset,
    );

    if (max === null) {
      return upperBounded;
    }

    return Math.max(minimumOffset, upperBounded);
  };

  /**
   * 拖动阶段使用的弹性边界。
   *
   * 用户可以短暂拖过最小值或最大值，但越界后阻力增加，
   * 最多视觉越界约 18px。
   */
  const rubberBandOffset = (nextOffset: number) => {
    const MAX_OVERSCROLL = 18;
    const RESISTANCE = 0.28;

    if (nextOffset > ROLLER_PAD) {
      const distance = nextOffset - ROLLER_PAD;

      return (
        ROLLER_PAD +
        Math.min(
          MAX_OVERSCROLL,
          distance * RESISTANCE,
        )
      );
    }

    if (
      max !== null &&
      nextOffset < minimumOffset
    ) {
      const distance =
        nextOffset - minimumOffset;

      return (
        minimumOffset +
        Math.max(
          -MAX_OVERSCROLL,
          distance * RESISTANCE,
        )
      );
    }

    return nextOffset;
  };

  const offsetToValue = (nextOffset: number) => {
    const clamped = clampOffset(nextOffset);

    const index = Math.round(
      (ROLLER_PAD - clamped) /
        ROLLER_ITEM_WIDTH,
    );

    return normalizeValue(index + 1);
  };

  const clearMotionTimers = () => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(
        settleTimerRef.current,
      );

      settleTimerRef.current = null;
    }

    if (confirmTimerRef.current !== null) {
      window.clearTimeout(
        confirmTimerRef.current,
      );

      confirmTimerRef.current = null;
    }

    if (confirmFrameRef.current !== null) {
      window.cancelAnimationFrame(
        confirmFrameRef.current,
      );

      confirmFrameRef.current = null;
    }
  };

  /**
   * 外部 value 变化时同步轨道位置。
   *
   * 例如：
   * - 房间人数变化导致卧底数量自动下调
   * - 服务端返回了新的设置值
   * - 其他客户端修改了设置
   *
   * 拖动期间暂不覆盖本地位置，避免轨道突然跳动。
   */
  useEffect(() => {
    if (dragRef.current) return;

    const normalized = normalizeValue(value);

    setPreviewValue(normalized);
    setOffset(valueToOffset(normalized));
  }, [value, max, normalizeValue, valueToOffset]);

  useEffect(() => {
    return () => {
      clearMotionTimers();
    };
  }, []);

  /**
   * 无上限模式只渲染当前可视区域附近的数字，
   * 避免生成过大的 DOM 列表。
   */
  const firstItem =
    max === null
      ? Math.max(
          1,
          Math.floor(
            -offset / ROLLER_ITEM_WIDTH,
          ) - 4,
        )
      : 1;

  const itemCount =
    max === null
      ? Math.ceil(
          ROLLER_CONTAINER_WIDTH /
            ROLLER_ITEM_WIDTH,
        ) + 9
      : max;

  const trackOffset =
    max === null
      ? offset +
        (firstItem - 1) *
          ROLLER_ITEM_WIDTH
      : offset;

  /**
   * 如果上一次吸附动画尚未完成，用户又重新按下，
   * 读取当前屏幕中实际显示的 transform 位置。
   *
   * 这样可以从动画中间位置继续拖动，
   * 不会突然跳到上一动画的目标位置。
   */
  const readRenderedOffset = () => {
    const track = trackRef.current;

    if (!track) return offset;

    const transform =
      window.getComputedStyle(track).transform;

    if (
      !transform ||
      transform === "none"
    ) {
      return offset;
    }

    try {
      const matrix =
        new DOMMatrixReadOnly(transform);

      const renderedTrackOffset =
        matrix.m41;

      if (max === null) {
        return (
          renderedTrackOffset -
          (firstItem - 1) *
            ROLLER_ITEM_WIDTH
        );
      }

      return renderedTrackOffset;
    } catch {
      return offset;
    }
  };

  const startConfirmationAnimation = () => {
    setConfirming(false);

    /**
     * 等待一帧后重新添加 confirming，
     * 让连续选择时 CSS animation 也能重新触发。
     */
    confirmFrameRef.current =
      window.requestAnimationFrame(() => {
        setConfirming(true);

        confirmTimerRef.current =
          window.setTimeout(() => {
            setConfirming(false);
            confirmTimerRef.current = null;
          }, 380);
      });
  };

  /**
   * 让滚轮吸附到指定数字。
   */
  const settleToValue = (
    nextValue: number,
    options?: {
      notify?: boolean;
      confirm?: boolean;
    },
  ) => {
    const normalized =
      normalizeValue(nextValue);

    const shouldNotify =
      options?.notify ?? true;

    const shouldConfirm =
      options?.confirm ?? true;

    clearMotionTimers();

    setPreviewValue(normalized);
    setOffset(valueToOffset(normalized));
    setPhase("settling");

    if (shouldConfirm) {
      startConfirmationAnimation();
    } else {
      setConfirming(false);
    }

    settleTimerRef.current =
      window.setTimeout(() => {
        setPhase("idle");
        settleTimerRef.current = null;
      }, 420);

    if (
      shouldNotify &&
      normalized !== value
    ) {
      /**
       * 可选的轻微震动反馈。
       *
       * Android 部分浏览器支持，
       * iPhone Safari 通常会忽略。
       * 不支持时不会报错。
       */
      if (
        typeof navigator !== "undefined" &&
        "vibrate" in navigator &&
        typeof navigator.vibrate ===
          "function"
      ) {
        navigator.vibrate(8);
      }

      onChange(normalized);
    }
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    /**
     * 鼠标只响应左键。
     * 触摸屏和触控笔不受此条件影响。
     */
    if (
      event.pointerType === "mouse" &&
      event.button !== 0
    ) {
      return;
    }

    event.preventDefault();

    event.currentTarget.focus({
      preventScroll: true,
    });

    clearMotionTimers();
    setConfirming(false);

    const renderedOffset =
      readRenderedOffset();

    const now = performance.now();

    /**
     * 先记录真实显示位置，再关闭 transition，
     * 避免中断上一次吸附动画时发生跳跃。
     */
    setOffset(renderedOffset);
    setPreviewValue(
      offsetToValue(renderedOffset),
    );
    setPhase("dragging");

    dragRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,

      startX: event.clientX,
      startOffset: renderedOffset,

      lastX: event.clientX,
      lastTime: now,
      velocity: 0,

      moved: false,
    };

    event.currentTarget.setPointerCapture(
      event.pointerId,
    );
  };

  const handlePointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    const drag = dragRef.current;

    if (
      !drag ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    const totalDistance =
      event.clientX - drag.startX;

    /**
     * 手机手指轻点时会产生自然抖动，
     * 因此触摸输入使用更大的拖动判定阈值。
     */
    const movementThreshold =
      drag.pointerType === "touch"
        ? 7
        : 4;

    if (
      Math.abs(totalDistance) >
      movementThreshold
    ) {
      drag.moved = true;
    }

    const now = performance.now();

    const elapsed = Math.max(
      8,
      now - drag.lastTime,
    );

    const instantaneousVelocity =
      (event.clientX - drag.lastX) /
      elapsed;

    /**
     * 低通滤波处理速度。
     *
     * 避免最后一次 pointermove 的瞬时抖动，
     * 导致松手时意外跳到其他数字。
     */
    drag.velocity =
      drag.velocity * 0.72 +
      instantaneousVelocity * 0.28;

    drag.lastX = event.clientX;
    drag.lastTime = now;

    const rawOffset =
      drag.startOffset + totalDistance;

    const visualOffset =
      rubberBandOffset(rawOffset);

    setOffset(visualOffset);

    setPreviewValue(
      offsetToValue(visualOffset),
    );
  };

  const handlePointerUp = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    const drag = dragRef.current;

    dragRef.current = null;

    if (
      !drag ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    const totalDistance =
      event.clientX - drag.startX;

    const currentOffset =
      rubberBandOffset(
        drag.startOffset + totalDistance,
      );

    let nextValue: number;

    if (!drag.moved) {
      /**
       * 没有明显拖动时，视为点击数字。
       */
      const rect =
        event.currentTarget.getBoundingClientRect();

      const relativeX =
        event.clientX - rect.left;

      const clickedIndex = Math.floor(
        (relativeX - currentOffset) /
          ROLLER_ITEM_WIDTH,
      );

      nextValue =
        normalizeValue(clickedIndex + 1);
    } else {
      /**
       * 松手时加入少量速度预测。
       *
       * 手机触摸输入更加克制，避免快速抬手造成误选。
       */
      const maximumProjection =
        drag.pointerType === "touch"
          ? ROLLER_ITEM_WIDTH * 0.42
          : ROLLER_ITEM_WIDTH * 0.55;

      const velocityFactor =
        drag.pointerType === "touch"
          ? 72
          : 85;

      const projectedDistance = Math.max(
        -maximumProjection,
        Math.min(
          maximumProjection,
          drag.velocity * velocityFactor,
        ),
      );

      const projectedOffset =
        clampOffset(
          currentOffset +
            projectedDistance,
        );

      nextValue =
        offsetToValue(projectedOffset);
    }

    settleToValue(nextValue);

    try {
      event.currentTarget.releasePointerCapture(
        event.pointerId,
      );
    } catch {
      /**
       * Pointer capture 可能已经由浏览器释放。
       */
    }
  };

  const handlePointerCancel = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    const drag = dragRef.current;

    if (
      !drag ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    dragRef.current = null;

    /**
     * 浏览器识别为页面纵向滚动时，
     * 可能触发 pointercancel。
     *
     * 此时恢复到外部已确认值，
     * 不触发 onChange 和确认动画。
     */
    settleToValue(value, {
      notify: false,
      confirm: false,
    });
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (disabled) return;
    let nextValue: number | null = null;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextValue = previewValue - 1;
        break;

      case "ArrowRight":
      case "ArrowUp":
        nextValue = previewValue + 1;
        break;

      case "Home":
        nextValue = 1;
        break;

      case "End":
        if (max !== null) {
          nextValue = max;
        }
        break;

      default:
        return;
    }

    if (nextValue === null) return;

    event.preventDefault();

    settleToValue(nextValue);
  };

  const className = [
    "undercover-roller",

    phase === "dragging"
      ? "dragging"
      : "",

    phase === "settling"
      ? "settling"
      : "",

    confirming
      ? "confirming"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={{
        width: ROLLER_CONTAINER_WIDTH,
      }}
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-valuemin={1}
      aria-valuemax={max ?? undefined}
      aria-valuenow={previewValue}
      aria-valuetext={`${previewValue}`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={
        handlePointerCancel
      }
    >
      <div
        ref={trackRef}
        className="undercover-roller-track"
        style={{
          transform: `translate3d(${trackOffset}px, 0, 0)`,
        }}
      >
        {Array.from(
          { length: itemCount },
          (_, index) =>
            firstItem + index,
        ).map((number) => {
          const distance = Math.abs(
            number - previewValue,
          );

          const itemClassName = [
            "undercover-roller-item",

            distance === 0
              ? "active"
              : "",

            distance === 1
              ? "near"
              : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <span
              key={number}
              className={itemClassName}
              aria-hidden="true"
            >
              {number}
            </span>
          );
        })}
      </div>

      <span
        className="undercover-roller-window"
        aria-hidden="true"
      />
    </div>
  );
}

type ConfirmDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
};

// ============================================================================
// 摄像头选镜（最终方案）
//
// 结论：纯 Web 无法跨机型识别“1× 主摄”。因此策略是：
//   1) 优先打开上次真正扫码成功的 deviceId（本地记忆）；
//   2) 没有记忆时按软规则排序后置候选，先打开高概率镜头；
//   3) 打开后若一段时间内扫码不成功，自动串行尝试其他后置镜头；
//   4) 哪个镜头真正解出二维码，就记住哪个。
// 不再用“最大分辨率”判断主摄，分辨率只保留在调试日志里。
// ============================================================================

interface StoredCameraPreference {
  deviceId: string;
  label?: string;
  savedAt: number;
}

type ExtendedCameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  torch?: boolean[];
  zoom?: { min: number; max: number; step?: number };
};

const PREFERRED_CAMERA_STORAGE_KEY = "who-is-undercover:preferred-camera";

function readPreferredCamera(): StoredCameraPreference | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFERRED_CAMERA_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredCameraPreference | string | null;
      if (typeof parsed === "string") {
        // 旧格式：直接存的是 deviceId 字符串。
        return parsed ? { deviceId: parsed, savedAt: 0 } : null;
      }
      if (parsed && typeof parsed.deviceId === "string" && parsed.deviceId) {
        return { deviceId: parsed.deviceId, label: parsed.label, savedAt: parsed.savedAt ?? Date.now() };
      }
      return null;
    } catch {
      // JSON 解析失败：按旧格式字符串处理。
      return { deviceId: raw, savedAt: 0 };
    }
  } catch {
    // 隐私模式等场景下忽略。
  }
  return null;
}

function storePreferredCamera(deviceId: string, label?: string) {
  if (typeof window === "undefined" || !deviceId) return;
  try {
    const entry: StoredCameraPreference = { deviceId, label, savedAt: Date.now() };
    window.localStorage.setItem(PREFERRED_CAMERA_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // 隐私模式等场景下忽略。
  }
}

function clearPreferredCamera() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFERRED_CAMERA_STORAGE_KEY);
  } catch {
    // 忽略。
  }
}

// 朝向判断：优先用 InputDeviceInfo.getCapabilities().facingMode，标签关键词仅作回退。
function classifyCameraFacing(device: MediaDeviceInfo): "environment" | "user" | "unknown" {
  try {
    const capabilities = (device as InputDeviceInfo).getCapabilities?.();
    const facingModes = capabilities?.facingMode ?? [];
    if (facingModes.includes("environment")) return "environment";
    if (facingModes.includes("user")) return "user";
  } catch {
    // 能力不可用时继续用标签判断。
  }
  const label = device.label.toLowerCase();
  if (label.includes("back") || label.includes("rear") || label.includes("environment") || label.includes("后置") || label.includes("背面")) return "environment";
  if (label.includes("front") || label.includes("user") || label.includes("前置")) return "user";
  return "unknown";
}

function cameraLabelIndex(device: MediaDeviceInfo): number | null {
  const match = device.label.match(/(?:camera2\s+|camera\s*)(\d+)/i);
  return match ? Number(match[1]) : null;
}

// 仅用于调试日志，不参与主摄排序。
function cameraMaxWidth(device: MediaDeviceInfo): number {
  try {
    const caps = (device as InputDeviceInfo).getCapabilities?.() as ExtendedCameraCapabilities | undefined;
    const width = caps?.width?.max ?? 0;
    const height = caps?.height?.max ?? 0;
    return Math.max(width, Math.round(height * 4 / 3));
  } catch {
    return 0;
  }
}

// 候选排序只决定“先尝试谁”，不保证正确性。
function cameraScore(device: MediaDeviceInfo, preferredId: string | null, bootstrapId: string | null): number {
  if (preferredId && device.deviceId === preferredId) return 10000;
  const label = device.label.toLowerCase();
  let score = 0;
  // 厂商经验规则：华为/部分三星中 camera 0 / camera2 0 常为主摄，只作软提示。
  if (/(?:camera2\s+0|camera\s*0)(?:\D|$)/i.test(label)) score += 80;
  if (bootstrapId && device.deviceId === bootstrapId) score += 15;
  // 明显偏向长焦/超广角/微距/景深的镜头放最后。
  if (/(telephoto|tele\b|zoom|macro|depth|tof|ultra[\s-]?wide|0\.5x)/i.test(label)) score -= 100;
  try {
    const caps = (device as InputDeviceInfo).getCapabilities?.() as ExtendedCameraCapabilities | undefined;
    if (caps?.focusMode?.includes("continuous")) score += 30;
    else if (caps?.focusMode?.includes("single-shot")) score += 10;
    if (caps?.torch?.includes(true)) score += 5;
  } catch {
    // 无能力数据时保持原分数。
  }
  return score;
}

function rearCameraCandidates(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const definitelyBack = devices.filter((device) => classifyCameraFacing(device) === "environment");
  const notDefinitelyFront = devices.filter((device) => classifyCameraFacing(device) !== "user");
  return definitelyBack.length > 0 ? definitelyBack : notDefinitelyFront;
}

function sortCameraCandidates(devices: MediaDeviceInfo[], preferredId: string | null, bootstrapId: string | null): MediaDeviceInfo[] {
  return [...devices].sort((a, b) => cameraScore(b, preferredId, bootstrapId) - cameraScore(a, preferredId, bootstrapId));
}

// 设备已打开后，再把 zoom=1 / 连续对焦作为 track 级微调应用（不参与摄像头选择）。
async function tuneCameraTrack(track: MediaStreamTrack) {
  try {
    const capabilities = track.getCapabilities() as ExtendedCameraCapabilities;
    const advanced: MediaTrackConstraintSet[] = [];
    if (capabilities.zoom && capabilities.zoom.min <= 1 && capabilities.zoom.max >= 1) {
      advanced.push({ zoom: 1 } as MediaTrackConstraintSet);
    }
    if (capabilities.focusMode?.includes("continuous")) {
      advanced.push({ focusMode: "continuous" } as MediaTrackConstraintSet);
    }
    if (advanced.length > 0) {
      await track.applyConstraints({ advanced });
    }
  } catch {
    // 不支持 zoom / 连续对焦或需要额外权限时忽略。
  }
}

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
};

function createBarcodeDetector(): BarcodeDetectorLike | null {
  const Constructor = (window as Window & {
    BarcodeDetector?: new (options?: { formats: string[] }) => BarcodeDetectorLike;
  }).BarcodeDetector;
  if (!Constructor) return null;
  try {
    return new Constructor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

// 解码层：优先原生 BarcodeDetector，不支持或失败时回退 jsQR 软件解码。
// 复用单一扫描 Canvas/Context，避免每轮创建（B035）；原生可用时 jsQR 每 3 帧补充一次（B034）。
const scanCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
let scanContext: CanvasRenderingContext2D | null = null;

async function decodeVideoFrame(
  video: HTMLVideoElement,
  detector: BarcodeDetectorLike | null,
  frameIndex: number,
): Promise<string | null> {
  if (detector) {
    try {
      const results = await detector.detect(video);
      const value = results[0]?.rawValue;
      if (value) return value;
    } catch {
      // 帧解码失败时继续软件解码。
    }
    if (frameIndex % 3 !== 0) return null;
  }
  const scale = Math.min(1, 640 / Math.max(1, video.videoWidth));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (!scanCanvas) return null;
  if (scanCanvas.width !== width) scanCanvas.width = width;
  if (scanCanvas.height !== height) scanCanvas.height = height;
  scanContext = scanContext ?? scanCanvas.getContext("2d", { willReadFrequently: true });
  if (!scanContext) return null;
  scanContext.drawImage(video, 0, 0, width, height);
  const imageData = scanContext.getImageData(0, 0, width, height);
  const code = jsQR(imageData.data, width, height, { inversionAttempts: "dontInvert" });
  return code?.data ?? null;
}

async function decodeImageCanvas(canvas: HTMLCanvasElement, imageData: ImageData, detector: BarcodeDetectorLike | null): Promise<string | null> {
  if (detector) {
    try {
      const results = await detector.detect(canvas);
      const value = results[0]?.rawValue;
      if (value) return value;
    } catch {
      // 继续软件解码。
    }
  }
  const normal = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
  if (normal) return normal.data;
  // 正常识别失败后再尝试反色二维码（F042）。
  const inverted = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
  return inverted?.data ?? null;
}

type CameraSwitchReason = "preferred" | "heuristic" | "manual" | "fallback";
type CameraPhase = "loading" | "line-opening" | "picture-opening" | "ready" | "pre-closing" | "picture-closing" | "line-closing" | "switching" | "error" | "closed";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

// 等待浏览器真正输出一帧视频后再开始展开动画。
// 无论成功、超时还是取消，都会移除事件监听器（B039）。
function waitForFirstVideoFrame(video: HTMLVideoElement, timeout = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timeoutId = 0;
    const onLoadedData = () => finish();
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", onLoadedData);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      // 再等待两个绘制周期，避免首帧还没真正显示。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    };
    timeoutId = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error("Camera first frame timeout"));
    }, timeout);
    const videoWithFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (videoWithFrameCallback.requestVideoFrameCallback) {
      videoWithFrameCallback.requestVideoFrameCallback(() => finish());
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      finish();
      return;
    }
    video.addEventListener("loadeddata", onLoadedData);
  });
}

// 被惩罚玩家自己的弃牌揭示：问号牌翻过来放大展示，点击后丢出屏幕。
// 翻牌动画（0.85s）完成前不允许丢弃（F016）；用 key 区分每次揭示。
function ChallengeLostCardReveal({ action, onDismiss }: { action: string; onDismiss: () => void }) {
  const [flipped, setFlipped] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const flipTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    flipTimerRef.current = window.setTimeout(() => setFlipped(true), 850);
    return () => window.clearTimeout(flipTimerRef.current);
  }, [action]);
  const dismiss = () => {
    if (!flipped || discarding) return;
    setDiscarding(true);
  };
  return createPortal(
    <div className={`lost-card-overlay${flipped ? " lost-card-overlay-ready" : " lost-card-overlay-flipping"}`} role="dialog" aria-modal="true" aria-labelledby="lost-card-title">
      <div className="lost-card-scene" role="button" tabIndex={flipped ? 0 : -1} aria-label="丢弃这张牌" onClick={dismiss} onKeyDown={(event) => {
        if (!flipped) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          dismiss();
        }
      }}>
        <div className={`lost-card${discarding ? " lost-card-throwing" : ""}`} onAnimationEnd={(event) => {
          if (event.animationName === "lost-card-throw") {
            setDiscarding(false);
            onDismiss();
          }
        }}>
          <div className="lost-card-inner">
            <div className="lost-card-face lost-card-face-back">
              <span className="lost-card-back-mark">?</span>
              <strong>你的牌</strong>
            </div>
            <div className="lost-card-face lost-card-face-front">
              <span className="lost-card-eyebrow">你违反了</span>
              <span className="lost-card-action">{action}</span>
              <small>{flipped ? "点击丢弃" : "正在翻开…"}</small>
            </div>
          </div>
        </div>
      </div>
      <p id="lost-card-title" className="lost-card-hint">{flipped ? "犯规了！点击丢弃这张牌" : "犯规了！正在翻开…"}</p>
    </div>,
    document.body,
  );
}

/** 进度条：出现/消失都有 Presence 过渡，不再直接推动布局（F097）。 */
function ProgressBar({ count, total }: { count: number; total: number }) {
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <m.div
          key="progress-bar"
          className="vote-ready-bar"
          initial={{ opacity: 0, height: 0, overflow: "hidden" }}
          animate={{ opacity: 1, height: "auto", overflow: "visible" }}
          exit={{ opacity: 0, height: 0, overflow: "hidden" }}
          transition={motionTokens.layout}
        >
          <div className="vote-ready-track"><div className="vote-ready-fill" style={{ width: `${total ? (count / total) * 100 : 0}%` }} /></div>
          <span className="vote-ready-count">{count}/{total}</span>
        </m.div>
      )}
    </AnimatePresence>
  );
}

export default function Home() {
  const [platformProfile, setPlatformProfile] = useState<TiGameUserProfile | null>(() => getPlatformBridge()?.getUserProfile?.() ?? null);
  const [screen, setScreen] = useState<Screen>("home");
  const [room, setRoom] = useState<Room | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  // 房主在游戏中点击“返回大厅”时选择“暂时离开 / 结束游戏”的弹窗。
  const [leaveGameDialog, setLeaveGameDialog] = useState(false);
  // “结束游戏”两步确认：第一次点击进入待确认（高亮），再点一次才真正结束。
  const [endGameArmed, setEndGameArmed] = useState(false);
  // armed 状态 3 秒后自动过期，避免长时间停留后误触危险操作（F013）。
  const armedExpireRef = useRef<number | undefined>(undefined);
  // “离开房间”两步确认：与“结束游戏”一致。
  const [leaveArmed, setLeaveArmed] = useState(false);
  // 房主离开提示的淡入淡出控制。
  const [leaveHintVisible, setLeaveHintVisible] = useState(false);
  const [leaveHintLeaving, setLeaveHintLeaving] = useState(false);
  const leaveHintTimerRef = useRef<number | undefined>(undefined);

  const setLeaveHint = useCallback((show: boolean) => {
    if (leaveHintTimerRef.current) window.clearTimeout(leaveHintTimerRef.current);
    leaveHintTimerRef.current = undefined;
    if (show) {
      setLeaveHintLeaving(false);
      setLeaveHintVisible(true);
      return;
    }
    // 先播放淡出与收起动画，动画结束后再真正移除。
    setLeaveHintLeaving(true);
    leaveHintTimerRef.current = window.setTimeout(() => {
      setLeaveHintVisible(false);
      setLeaveHintLeaving(false);
    }, 320);
  }, []);
  // 房主刚同意加入的玩家：驱动玩家列表里的入场动效。
  const [justJoinedId, setJustJoinedId] = useState<string | null>(null);
  const justJoinedTimerRef = useRef<number | undefined>(undefined);
  // 申请行退场动效：服务器确认后先播放收起动画，再真正移除。
  const [leavingRequests, setLeavingRequests] = useState<Array<{ id: string; playerName: string; avatarData?: string }>>([]);
  // 飞行头像：申请列表的头像飞向玩家列表的对应位置。
  const [joinFlight, setJoinFlight] = useState<JoinFlight | null>(null);
  const joinFlightRef = useRef<JoinFlight | null>(null);
  // 等待飞行头像落地前，先隐藏新玩家所在行。
  const [incomingId, setIncomingId] = useState<string | null>(null);
  const incomingRef = useRef<string | null>(null);
  const flightFallbackTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState(() => platformProfile?.nickname || readStoredNickname());
  const [joinStep, setJoinStep] = useState(0);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraClosing, setCameraClosing] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("");
  const [cameraSwitchVisible, setCameraSwitchVisible] = useState(false);
  const [cameraPhase, setCameraPhase] = useState<CameraPhase>("loading");
  // 摄像头显式控制器（避免依赖 React effect 竞态，切换期间互斥）：
  const streamRef = useRef<MediaStream | null>(null);
  const openSequenceRef = useRef(0);
  const switchingRef = useRef(false);
  const candidateDevicesRef = useRef<MediaDeviceInfo[]>([]);
  const activeCandidateIndexRef = useRef(-1);
  const activeCameraDeviceIdRef = useRef<string | null>(null);

  const [joinStatus, setJoinStatus] = useState<"idle" | "submitting" | "waiting" | "error">("idle");
  // 创建房间 / 校验邀请码 / 批准加入的进行中状态（F005/F006/F033/F034/F003）。
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [checkingJoin, setCheckingJoin] = useState(false);
  const [approvingRequestId, setApprovingRequestId] = useState<string | null>(null);
  const [cardRevealed, setCardRevealed] = useState(false);
  // 翻转方向只在本地记录，每次翻开交替左/右，不与其他玩家同步。
  const [flipRight, setFlipRight] = useState(true);
  // 保证“一次翻开只切换一次方向”，防止个别设备 pointerdown 重复触发导致方向被切回原位。
  const flipToggledRef = useRef(false);
  // 房主长按头像弹出的踢出菜单
  const [kickMenuFor, setKickMenuFor] = useState<string | null>(null);
  const [voteTarget, setVoteTarget] = useState("");
  const [confirmedVote, setConfirmedVote] = useState("");
  const [mahjongTarget, setMahjongTarget] = useState("");
  const [mahjongPoints, setMahjongPoints] = useState("");
  // 给分子卡片动画状态机：先展开空间，再整体放入/移出子卡片。
  type MahjongTransferPhase =
    | "closed"
    | "preparing"
    | "expanding"
    | "entering"
    | "open"
    | "exiting"
    | "collapsing";
  const [transferPhase, setTransferPhase] = useState<MahjongTransferPhase>("closed");
  const transferPhaseRef = useRef<MahjongTransferPhase>("closed");
  useEffect(() => {
    transferPhaseRef.current = transferPhase;
  }, [transferPhase]);
  const transferSlotRef = useRef<HTMLDivElement>(null);
  const transferStageRef = useRef<HTMLDivElement>(null);
  const transferRafRef = useRef<number | undefined>(undefined);
  // 长按滑动调数：触发与结束时各播一次输入框外围涟漪；触发期间保持静态高亮。
  const [mahjongRipple, setMahjongRipple] = useState<{ key: number; phase: "activate" | "release" } | null>(null);
  const [mahjongAdjusting, setMahjongAdjusting] = useState(false);
  // 网页内数字键盘（替代系统键盘）
  const [mahjongKeypadOpen, setMahjongKeypadOpen] = useState(false);
  const [mahjongKeypadClosing, setMahjongKeypadClosing] = useState(false);
  const mahjongKeypadRef = useRef<HTMLDivElement>(null);
  const mahjongBackspaceTimerRef = useRef<number | undefined>(undefined);
  const mahjongKeypadScrollGuardRef = useRef(false);
  const mahjongSettleScrolledRef = useRef(false);
  // 键盘相关计时器保存到 ref，便于卸载/重开时清理（P2-03/F087）。
  const mahjongKeypadGuardTimerRef = useRef<number | undefined>(undefined);
  const mahjongKeypadCloseTimerRef = useRef<number | undefined>(undefined);
  const copyTimerRef = useRef<number | undefined>(undefined);
  // 打开键盘前的页面滚动位置，以及关闭后是否需要恢复（用户主动滚动收起时不恢复）。
  const mahjongKeypadOpenScrollYRef = useRef<number | null>(null);
  const mahjongKeypadRestoreScrollRef = useRef(true);
  // 桌面鼠标设备不弹自定义数字键盘，保持正常输入。
  const [finePointer] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches);
  // 转分发送状态机：idle 可编辑；sending/retrying 锁定并自动重试同一 operationId；
  // rejected 为服务端明确拒绝（恢复编辑，输入保留）。
  type MahjongTransferState =
    | { phase: "idle" }
    | { phase: "sending" | "retrying"; operationId: string; targetId: string; targetName: string; points: number; attempts: number }
    | { phase: "rejected"; targetId: string; targetName: string; points: number; error: string };
  const [transferState, setTransferState] = useState<MahjongTransferState>({ phase: "idle" });
  // 同步忙碌锁：发送/重试期间锁定输入、目标与面板关闭（state 更新是异步的）。
  const transferBusyRef = useRef(false);
  // 整笔转分生命周期的同步锁：从提交到明确成功/失败前，面板、输入与目标都不可操作。
  // 与 busyRef 区分：busyRef 只在单次请求进行中为 true（重试间隔会释放），
  // lockedRef 在整个发送/重试期间保持 true，避免“卡住时收起面板再打开变成空输入”的误解。
  const transferLockedRef = useRef(false);
  // 自动重试定时器；pendingTransferRef 保存当前在途操作，用于晚到 ACK 的身份校验。
  const transferRetryTimerRef = useRef<number | undefined>(undefined);
  const pendingTransferRef = useRef<{ operationId: string; targetId: string; targetName: string; points: number } | null>(null);
  // 连接恢复后立即重试未确认转分的触发点（定义在后面，经 ref 转发避免 TDZ）。
  const nudgeTransferRetryRef = useRef<(() => void) | null>(null);
  // 向所有人收取面板与发送状态（长按自己的磁贴触发）。
  // 给分面板当前模式：give=给某人分数；collect=向所有人收取（复用同一套展开/收起动效）。
  const [transferMode, setTransferMode] = useState<"give" | "collect">("give");
  const [mahjongCollectPoints, setMahjongCollectPoints] = useState("");
  const [mahjongCollectSending, setMahjongCollectSending] = useState(false);
  const mahjongCollectSendingRef = useRef(false);
  const pendingCollectOpRef = useRef<{ operationId: string; points: number } | null>(null);
  const selfTilePressRef = useRef<{ timer: number | undefined } | null>(null);
  const selfTileLongPressRef = useRef(false);
  // 收取被否决时给发起者的红色提示（点击“知道了”关闭）。
  const [collectRejectedNotice, setCollectRejectedNotice] = useState<{ key: number; voterName: string; points: number } | null>(null);
  // 自己磁贴长按进度圈：filling=随长按填充；bursting=触发后向外扩散消失。
  const [selfTileRing, setSelfTileRing] = useState<{ key: number; phase: "filling" | "bursting" } | null>(null);
  // 发送状态提示分级：0=发送中，1=5s 后网络缓慢，2=15s 后可能故障。
  const [transferWarnTier, setTransferWarnTier] = useState(0);
  const transferWarnTimerRef = useRef<number | undefined>(undefined);
  const startTransferWarnTimers = useCallback(() => {
    if (transferWarnTimerRef.current !== undefined) window.clearTimeout(transferWarnTimerRef.current);
    setTransferWarnTier(0);
    transferWarnTimerRef.current = window.setTimeout(() => {
      setTransferWarnTier(1);
      transferWarnTimerRef.current = window.setTimeout(() => {
        transferWarnTimerRef.current = undefined;
        setTransferWarnTier(2);
      }, 10_000);
    }, 5_000);
  }, []);
  const stopTransferWarnTimers = useCallback(() => {
    if (transferWarnTimerRef.current !== undefined) window.clearTimeout(transferWarnTimerRef.current);
    transferWarnTimerRef.current = undefined;
    setTransferWarnTier(0);
  }, []);

  const stopMahjongKeypadBackspace = useCallback(() => {
    if (mahjongBackspaceTimerRef.current !== undefined) {
      window.clearInterval(mahjongBackspaceTimerRef.current);
      mahjongBackspaceTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopMahjongKeypadBackspace();
      if (mahjongKeypadGuardTimerRef.current !== undefined) window.clearTimeout(mahjongKeypadGuardTimerRef.current);
      if (mahjongKeypadCloseTimerRef.current !== undefined) window.clearTimeout(mahjongKeypadCloseTimerRef.current);
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      if (transferRetryTimerRef.current !== undefined) window.clearTimeout(transferRetryTimerRef.current);
      if (transferWarnTimerRef.current !== undefined) window.clearTimeout(transferWarnTimerRef.current);
    };
  }, [stopMahjongKeypadBackspace]);

  const closeMahjongKeypad = useCallback(() => {
    if (!mahjongKeypadOpen || mahjongKeypadClosing) return;
    if (mahjongKeypadCloseTimerRef.current !== undefined) window.clearTimeout(mahjongKeypadCloseTimerRef.current);
    stopMahjongKeypadBackspace();
    setMahjongKeypadClosing(true);
    mahjongKeypadCloseTimerRef.current = window.setTimeout(() => {
      mahjongKeypadCloseTimerRef.current = undefined;
      setMahjongKeypadClosing(false);
      setMahjongKeypadOpen(false);
      // 恢复打开键盘导致的页面滚动。
      if (mahjongKeypadRestoreScrollRef.current && mahjongKeypadOpenScrollYRef.current !== null) {
        const restoreY = mahjongKeypadOpenScrollYRef.current;
        mahjongKeypadOpenScrollYRef.current = null;
        if (Math.abs(window.scrollY - restoreY) > 2) {
          window.scrollTo({ top: restoreY, behavior: "smooth" });
        }
      } else {
        mahjongKeypadOpenScrollYRef.current = null;
      }
    }, 220);
  }, [mahjongKeypadOpen, mahjongKeypadClosing, stopMahjongKeypadBackspace]);
  const [cardAssetFailed, setCardAssetFailed] = useState(false);
  // 投票结果（未结算/平票）按玩家本地关闭：每个人点“继续”只关自己的结果页。
  const [pendingVoteResult, setPendingVoteResult] = useState<{
    key: string;
    round: number;
    counts: Array<{ playerId: string; playerName: string; count: number; voterIds: string[] }>;
    eliminatedPlayerId: string;
    eliminatedName: string;
    tie: boolean;
  } | null>(null);
  // 本机已点“继续”关闭过的结果 key，防止后续广播又把它弹出来。
  const dismissedVoteResultKeyRef = useRef<string | null>(null);
  const [secretCard, setSecretCard] = useState<SecretCard | null>(null);
  const [wsStatus, setWsStatus] = useState<"closed" | "connecting" | "open">("closed");
  // 断线重连阶段：retrying=退避重试；waiting-network=等待网络恢复；syncing=握手完成待同步。
  const [reconnectPhase, setReconnectPhase] = useState<ReconnectPhase>("idle");
  const [resuming, setResuming] = useState(false);
  // 挑战牌变化动效：服务端广播携带事件类型（惩罚/换牌/奖励），驱动对应玩家的卡牌动画。
  const [cardAnim, setCardAnim] = useState<{ playerId: string; kind: "penalize" | "swap" | "reward"; nonce: number } | null>(null);
  // 被惩罚玩家自己的弃牌揭示：由服务端私密事件触发，不进公共房间快照（B002/B015）。
  const [challengeReveal, setChallengeReveal] = useState<{ action: string; key: string } | null>(null);
  const [form, setForm] = useState(() => ({ name: platformProfile?.nickname || readStoredNickname() }));

  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const socketSessionRef = useRef<StoredSession | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const stableTimerRef = useRef<number | undefined>(undefined);
  const kickMenuTimerRef = useRef<number | undefined>(undefined);
  const [kickMenuPos, setKickMenuPos] = useState<{ x: number; y: number } | null>(null);
  const reconnectAttemptRef = useRef(0);
  // 已应用的房间版本号：忽略旧连接/旧快照的延迟消息（B024/B026）。
  const appliedRevisionRef = useRef(0);
  // 等待服务器 ACK 的命令（4.3）。
  const pendingCommandsRef = useRef<Map<string, (result: CommandResult) => void>>(new Map());
  // 长按踢人成功后抑制同一次点击触发的投票（F015）。
  const suppressAvatarClickRef = useRef(false);
  // 批准动画在服务端事件中触发；这两个回调定义在后面，通过 ref 转发避免 TDZ。
  const startJoinFlightRef = useRef<(id: string, name: string, avatarData?: string) => void>(() => {});
  const beginRequestExitRef = useRef<(id: string, name: string, avatarData?: string) => void>(() => {});
  // 扫码成功后的统一退出/验证由后面的函数实现，通过 ref 转发（F008/F010）。
  const closeScannerRef = useRef<(reason: "button" | "scan" | "image") => Promise<void>>(async () => {});
  const verifyJoinCodeRef = useRef<(code: string) => Promise<boolean>>(async () => false);
  // bootstrap 摄像头流复用（B037）：若首选候选就是 bootstrap 镜头则直接沿用。
  const bootstrapStreamRef = useRef<MediaStream | null>(null);
  // connectSocket 在退避回调中递归调用自身，用 ref 转发避免 TDZ。
  const connectSocketRef = useRef<(session: StoredSession) => void>(() => {});
  const stoppedRef = useRef(true);
  const secretCardRef = useRef<SecretCard | null>(null);
  const lastVoteRoundRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 二维码 canvas 用回调 ref 存入 state：屏幕切换 Presence 会让大厅内容晚一拍挂载，
  // 若只依赖 screen/inviteUrl，effect 会在 canvas 出现前空跑一次，导致二维码不绘制。
  const [qrCanvas, setQrCanvas] = useState<HTMLCanvasElement | null>(null);
  const handleServerMessageRef = useRef<(raw: string) => void>(() => {});

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const updateSecretCard = useCallback((nextCard: SecretCard | null) => {
    secretCardRef.current = nextCard;
    setSecretCard(nextCard);
  }, []);

  const applySessionToken = useCallback((token: string) => {
    const session = sessionRef.current;
    if (!session) return;
    const next: StoredSession = { ...session, token };
    sessionRef.current = next;
    if (
      socketSessionRef.current
      && socketSessionRef.current.roomId === session.roomId
      && socketSessionRef.current.playerId === session.playerId
    ) {
      socketSessionRef.current = next;
    }
    storeSession(next);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!confirmDialog && !leaveGameDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmDialog(null);
        setLeaveGameDialog(false);
        setEndGameArmed(false);
        if (leaveArmed) setLeaveHint(false);
        setLeaveArmed(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmDialog, leaveGameDialog, leaveArmed, setLeaveHint]);

  // “结束游戏 / 离开房间”进入待确认后，点击其它任意位置取消高亮。
  useEffect(() => {
    if (!endGameArmed && !leaveArmed) return;
    const cancelArmed = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".armed-target")) {
        setEndGameArmed(false);
        if (leaveArmed) setLeaveHint(false);
        setLeaveArmed(false);
      }
    };
    document.addEventListener("pointerdown", cancelArmed);
    return () => document.removeEventListener("pointerdown", cancelArmed);
  }, [endGameArmed, leaveArmed, setLeaveHint]);

  const applySharedRoom = useCallback((shared: PublicRoom) => {
    const session = sessionRef.current;
    if (!session) return;
    const me = shared.players.find((player) => player.id === session.playerId);
    const pendingMe = shared.pendingJoinRequests.some((request) => request.id === session.playerId);
    if (!me && !pendingMe) return;
    setResuming(false);
    // 本机玩家在自己的界面上始终显示为在线：房间刚创建/刚重连时，
    // WebSocket 握手（hello）尚未返回，服务器侧的 online 还是 false，
    // 直接显示会导致“房主/自己刚进房间显示断线，几秒后才变在线”。
    const players = me
      ? [{ ...me, online: true }, ...shared.players.filter((player) => player.id !== me.id)]
      : shared.players;
    const next: Room = { ...shared, players, localPlayerId: session.playerId };
    const prev = roomRef.current;
    roomRef.current = next;
    setRoom(next);
    // 房主批准加入后，给新加入的玩家一行入场动效。
    // 若该玩家正处于“头像飞行”流程中，玩家行先保持隐藏，等头像落地后再弹出；
    // 否则（其他途径加入）直接播放入场动效。
    if (prev && session.playerId === next.hostId) {
      const prevIds = new Set(prev.players.map((player) => player.id));
      const joined = players.find((player) => !prevIds.has(player.id) && player.id !== session.playerId);
      if (joined) {
        if (incomingRef.current === joined.id) {
          setIncomingId(joined.id);
        } else {
          setJustJoinedId(joined.id);
          if (justJoinedTimerRef.current) window.clearTimeout(justJoinedTimerRef.current);
          justJoinedTimerRef.current = window.setTimeout(() => setJustJoinedId(null), 2200);
        }
      }
    }
    const game = shared.game;
    if (game?.kind !== "undercover" || game.round !== secretCardRef.current?.round) {
      updateSecretCard(null);
    }
    if (game?.kind !== "undercover" || game.phase !== "VOTING" || game.round !== lastVoteRoundRef.current) {
      setVoteTarget("");
      setConfirmedVote("");
    }
    if (game?.kind === "undercover" && game.phase === "VOTING") {
      lastVoteRoundRef.current = game.round;
    }
    // 捕获“投票结果”供本地展示；点“继续”只关闭自己，服务端可先行推进。
    if (game?.kind === "undercover") {
      const result = game.voteResult;
      const captureKey = game.phase === "PLAYING" && result && result.winner === null && result.round === game.round
        ? `${result.round}-${result.eliminatedPlayerId}-${result.tie ? "-tie" : ""}-${result.voteCounts.length}`
        : null;
      if (captureKey && result) {
        // 本机已经点“继续”关闭过的结果，不再重复弹出。
        if (dismissedVoteResultKeyRef.current === captureKey) return;
        setPendingVoteResult((prev) => {
          if (prev && prev.key === captureKey) return prev;
          return {
            key: captureKey,
            round: result.round,
            counts: result.voteCounts,
            eliminatedPlayerId: result.eliminatedPlayerId,
            eliminatedName: result.eliminatedPlayerName || "无人",
            tie: result.tie,
          };
        });
      } else {
        if (game.phase !== "PLAYING") dismissedVoteResultKeyRef.current = null;
        setPendingVoteResult((prev) => {
          if (!prev) return prev;
          // 进入投票/结算/新局等阶段，或 voteResult 已被新一轮准备清空时，收起本地结果页。
          const stale = game.round !== prev.round || game.phase !== "PLAYING" || !result;
          return stale ? null : prev;
        });
      }
    }
  }, [updateSecretCard]);

  // 飞行头像的目标点：新玩家行渲染后，测量其头像位置并开始飞行。
  useEffect(() => {
    const flight = joinFlight;
    if (!flight || flight.to) return;
    const joinedPlayer = room?.players.find((player) => player.id === flight.id);
    const rowEl = document.querySelector<HTMLElement>(`[data-player-id="${flight.id}"]`);
    const avatarEl = rowEl?.querySelector<HTMLElement>(".avatar");
    if (!joinedPlayer || !avatarEl) return;
    const rect = avatarEl.getBoundingClientRect();
    const next: JoinFlight = {
      ...flight,
      color: joinedPlayer.color,
      to: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
    joinFlightRef.current = next;
    // 下一帧再写入状态，避免在 effect 内同步 setState 造成级联渲染。
    const frame = window.requestAnimationFrame(() => setJoinFlight(next));
    return () => window.cancelAnimationFrame(frame);
  }, [joinFlight, room]);

  // 统一会话终止：kicked、rejected、主动离开与会话失效共用（B025）。
  const terminateSession = useCallback(() => {
    stoppedRef.current = true;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = undefined;
    for (const [, resolveAck] of pendingCommandsRef.current) resolveAck({ status: "unknown", reason: "DISCONNECTED" });
    pendingCommandsRef.current.clear();
    // 会话结束时停止转分自动重试并清空本地 outbox（被踢/主动离开后无需再补发）。
    if (transferRetryTimerRef.current !== undefined) window.clearTimeout(transferRetryTimerRef.current);
    transferRetryTimerRef.current = undefined;
    transferBusyRef.current = false;
    transferLockedRef.current = false;
    pendingTransferRef.current = null;
    setTransferState({ phase: "idle" });
    writeTransferOutbox([]);
    stopTransferWarnTimers();
    try {
      wsRef.current?.close(1000, "bye");
    } catch {
      // Ignore closing errors.
    }
    wsRef.current = null;
    socketSessionRef.current = null;
    sessionRef.current = null;
    roomRef.current = null;
    clearStoredSession();
    setRoom(null);
    updateSecretCard(null);
    setWsStatus("closed");
    setReconnectPhase("idle");
    setResuming(false);
    setJustJoinedId(null);
    setLeavingRequests([]);
    setJoinFlight(null);
    joinFlightRef.current = null;
    setIncomingId(null);
    incomingRef.current = null;
    if (flightFallbackTimerRef.current) window.clearTimeout(flightFallbackTimerRef.current);
    flightFallbackTimerRef.current = undefined;
    appliedRevisionRef.current = 0;
  }, [updateSecretCard, stopTransferWarnTimers]);

  const handleKicked = useCallback((reason?: string) => {
    terminateSession();
    setScreen("home");
    setNotice(reason || "你已被移出房间");
  }, [terminateSession]);

  // 连接真正恢复：收到最新房间快照（hello/room/approved）后再标记，避免握手成功就显示“已连接”。
  const markConnectionRecovered = useCallback(() => {
    setWsStatus("open");
    setReconnectPhase("idle");
    setResuming(false);
  }, []);

  // 房主暂时离开时，只有房主本人看到大厅；其余人仍留在对局界面。
  const screenForSharedRoom = (shared: PublicRoom): Screen => {
    const session = sessionRef.current;
    if (shared.hostInLobby && session && shared.hostId === session.playerId) return "lobby";
    return shared.phase === "GAME" ? "game" : "lobby";
  };

  const handleServerMessage = useCallback((raw: string) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "ack") {
      const resolveAck = pendingCommandsRef.current.get(message.id);
      if (resolveAck) {
        pendingCommandsRef.current.delete(message.id);
        resolveAck(
          message.ok
            ? { status: "confirmed", revision: message.revision, duplicate: message.duplicate }
            : { status: "rejected", error: message.error ?? "INVALID" },
        );
      }
      return;
    }
    switch (message.type) {
      case "hello":
        if (message.approved && message.room) {
          markConnectionRecovered();
          appliedRevisionRef.current = message.room.revision;
          if (message.token) applySessionToken(message.token);
          setJoinStatus("idle");
          applySharedRoom(message.room);
          if (message.card) {
            if ("round" in message.card) updateSecretCard(message.card);
          }
          setScreen(screenForSharedRoom(message.room));
        } else {
          // 待审批玩家（刷新/重连后）：回到“等待房主确认”步骤（joinStep 默认 0，必须显式恢复）。
          markConnectionRecovered();
          setResuming(false);
          setJoinStatus("waiting");
          setJoinStep(2);
          setScreen("join");
        }
        return;
      case "room": {
        // 旧连接/旧快照的延迟消息直接忽略（B024/B026）。
        if (message.room.revision <= appliedRevisionRef.current) return;
        markConnectionRecovered();
        appliedRevisionRef.current = message.room.revision;
        const event = message.event;
        // 房主批准加入：由服务端事件驱动退场与飞行动画，而不是点击时先行（F003）。
        if (event?.game === "room" && event.kind === "join-approved") {
          const request = roomRef.current?.pendingJoinRequests.find((item) => item.id === event.playerId);
          if (request) {
            beginRequestExitRef.current(request.id, request.playerName, request.avatarData);
            startJoinFlightRef.current(request.id, request.playerName, request.avatarData);
          }
          setApprovingRequestId(null);
        }
        applySharedRoom(message.room);
        if (event?.game === "challenge" && (event.kind === "penalize" || event.kind === "swap" || event.kind === "reward")) {
          setCardAnim({ playerId: event.playerId, kind: event.kind, nonce: Date.now() });
        }
        setScreen(screenForSharedRoom(message.room));
        return;
      }
      case "card":
        if (message.game === "undercover" && "round" in message.card) {
          updateSecretCard(message.card);
        }
        return;
      case "approved":
        markConnectionRecovered();
        appliedRevisionRef.current = message.room.revision;
        if (message.token) applySessionToken(message.token);
        setJoinStatus("idle");
        applySharedRoom(message.room);
        if (message.card) {
          if ("round" in message.card) updateSecretCard(message.card);
        }
        setScreen(screenForSharedRoom(message.room));
        setNotice("已加入房间");
        return;
      case "rejected":
        // B025：完整清理会话后再回到加入页，而不是只清一部分状态。
        terminateSession();
        setJoinStatus("error");
        setScreen("join");
        setNotice(message.reason || "加入申请被拒绝");
        return;
      case "kicked":
        handleKicked(message.reason);
        return;
      case "mahjong-collect-rejected":
        // 只有被否决收取的发起者会收到该事件。
        setCollectRejectedNotice({ key: Date.now(), voterName: message.voterName, points: message.points });
        return;
      case "challenge-lost-card":
        // 被惩罚玩家自己的弃牌揭示：由私密事件携带，不进公共快照（B002/B015）。
        setChallengeReveal({ action: message.action, key: message.eventId });
        return;
      case "left":
        // 主动离开的服务端确认（B023）：本地 goHome 已清理。
        return;
      case "ping":
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({ type: "pong" }));
          } catch {
            // 连接可能已关闭。
          }
        }
        return;
      default:
        return;
    }
  }, [applySharedRoom, applySessionToken, handleKicked, terminateSession, updateSecretCard, markConnectionRecovered]);

  useEffect(() => {
    handleServerMessageRef.current = handleServerMessage;
  }, [handleServerMessage]);

  const connectSocket = useCallback((session: StoredSession) => {
    if (stoppedRef.current) stoppedRef.current = false;
    const existing = wsRef.current;
    const sameCurrentSession = sameSession(existing ? socketSessionRef.current : null, session);
    if (existing && !sameCurrentSession) {
      try {
        existing.close(1000, "switch-session");
      } catch {
        // Ignore closing errors.
      }
      wsRef.current = null;
      socketSessionRef.current = null;
    }
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    sessionRef.current = session;
    socketSessionRef.current = session;
    const platformApiBase = getPlatformBridge()?.apiBase?.replace(/\/$/, "");
    const protocol = platformApiBase
      ? (platformApiBase.startsWith("https:") ? "wss:" : "ws:")
      : (window.location.protocol === "https:" ? "wss:" : "ws:");
    setWsStatus("connecting");

    const scheduleRetry = (closedSession: StoredSession | null) => {
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      // 断网期间保持当前页面，依靠网页内逻辑自动重连（hello/room 同步最新状态），
      // 不再把用户踢回首页，避免观感上像整页刷新。
      // 但每隔若干次重试向云端确认房间是否仍在，避免对已销毁的房间无限重连。
      if (attempt >= 6 && attempt % 6 === 0) {
        const currentSession = sessionRef.current;
        if (currentSession && !stoppedRef.current) {
          void probeRoomStatus(currentSession).then((status) => {
            if (stoppedRef.current || sessionRef.current !== currentSession) return;
            if (status === "member-gone") {
              handleKicked("你已不在该房间");
              return;
            }
            if (status === "room-gone") {
              terminateSession();
              setScreen("home");
              setNotice("房间已结束");
              return;
            }
            if (status === "auth-gone") {
              terminateSession();
              setScreen("home");
              setNotice("登录凭证已失效");
              return;
            }
            // alive / unknown（429/5xx/网络问题）：保持页面继续重试。
            scheduleRetry(closedSession);
          });
          return;
        }
      }
      const delay = nextReconnectDelay(attempt);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        const current = sessionRef.current;
        if (!current || stoppedRef.current) return;
        if (closedSession && !sameSession(closedSession, current)) return;
        connectSocketRef.current(current);
      }, delay);
    };

    // 通过认证 HTTP 换取单次使用的 ticket，URL 不再携带长期 token（B021）。
    void fetchWsTicket(session).then((ticket) => {
      if (stoppedRef.current || sessionRef.current !== session) return;
      if (!ticket) {
        setWsStatus("closed");
        scheduleRetry(session);
        return;
      }
      const socketBase = platformApiBase
        ? platformApiBase.replace(/^https?:/, protocol)
        : `${protocol}//${window.location.host}`;
      const url = `${socketBase}/api/ws?roomId=${encodeURIComponent(session.roomId)}&ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let syncTimer: number | undefined;
      const clearSyncTimer = () => {
        if (syncTimer !== undefined) window.clearTimeout(syncTimer);
        syncTimer = undefined;
      };
      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        // 握手成功后必须很快收到服务端 hello/room/approved。若首包丢失，主动重连，
        // 避免 SocketTask 已 OPEN 但页面永久停在“正在恢复连接”。
        setWsStatus("connecting");
        setReconnectPhase("syncing");
        clearSyncTimer();
        syncTimer = window.setTimeout(() => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
          console.warn("[TiGame] WebSocket opened but room sync timed out; reconnecting");
          try { ws.close(4000, "sync-timeout"); } catch {}
        }, 6_000);
        // 连接恢复后立即重试未确认的转分（同一 operationId，服务端幂等去重）。
        nudgeTransferRetryRef.current?.();
        // 只在连接真正稳定后重置退避计数（B004）。
        if (stableTimerRef.current) window.clearTimeout(stableTimerRef.current);
        stableTimerRef.current = window.setTimeout(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            reconnectAttemptRef.current = 0;
          }
        }, 10_000);
      };
      ws.onmessage = (event) => {
        // 旧 socket 的延迟消息一律忽略（B024）。
        if (wsRef.current !== ws) return;
        const raw = String(event.data);
        try {
          const envelope = JSON.parse(raw) as { type?: string };
          if (envelope.type === "hello" || envelope.type === "room" || envelope.type === "approved") clearSyncTimer();
        } catch {
          console.warn("[TiGame] ignored malformed WebSocket message", raw.slice(0, 160));
        }
        handleServerMessageRef.current(raw);
      };
      ws.onclose = (event) => {
        clearSyncTimer();
        if (wsRef.current !== ws) return;
        const closedSession = socketSessionRef.current;
        wsRef.current = null;
        socketSessionRef.current = null;
        setWsStatus("closed");
        // 当前房间仍存在时只改变连接状态，不改变 screen 和 room。
        if (roomRef.current) {
          setReconnectPhase(navigator.onLine ? "retrying" : "waiting-network");
        }
        // 连接断开时把挂起的命令标记为“结果未知”，转分进入自动重试。
        for (const [, resolveAck] of pendingCommandsRef.current) resolveAck({ status: "unknown", reason: "DISCONNECTED" });
        pendingCommandsRef.current.clear();
        if (stoppedRef.current) return;
        if (event.code === 4003) {
          handleKicked(event.reason || "你已被房主移出房间");
          return;
        }
        if (event.code === 1000 || event.code === 1001) {
          const reason = event.reason || "";
          // 只有服务器明确表示会话结束（被拒绝/主动离开）才清凭证；
          // 部署、重启等瞬时关闭保留会话，走下面的自动重连。
          if (reason === "rejected") {
            terminateSession();
            setJoinStatus("error");
            setScreen("join");
            setNotice("加入申请被拒绝");
            return;
          }
          if (reason === "leave") {
            handleKicked("已离开房间");
            return;
          }
        }
        // 首次异常断连：先向云端确认房间是否仍在（按状态码区分，临时 5xx 不算房间结束）。
        if (reconnectAttemptRef.current === 0) {
          const currentSession = sessionRef.current;
          if (currentSession && !stoppedRef.current) {
            void probeRoomStatus(currentSession).then((status) => {
              if (stoppedRef.current || sessionRef.current !== currentSession) return;
              if (status === "member-gone") {
                handleKicked("你已不在该房间");
                return;
              }
              if (status === "room-gone") {
                terminateSession();
                setScreen("home");
                setNotice("房间已结束");
                return;
              }
              if (status === "auth-gone") {
                terminateSession();
                setScreen("home");
                setNotice("登录凭证已失效");
                return;
              }
              // alive / unknown（429/5xx/网络问题）：保持页面与重试。
              scheduleRetry(closedSession);
            });
            return;
          }
        }
        scheduleRetry(closedSession);
      };
    });
  }, [handleKicked, terminateSession]);

  /** 等待服务器 ACK 的命令（4.3）：返回完整结果，区分“已确认/明确拒绝/结果未知”（P0-04 加固）。 */
  const sendCommandDetailed = useCallback((payload: Record<string, unknown>, options?: { id?: string }): Promise<CommandResult> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // 不在这里弹提示：自动重试会频繁命中此分支，通知由调用方决定。
      return Promise.resolve({ status: "unknown", reason: "DISCONNECTED" });
    }
    const id = options?.id ?? newUuid();
    return new Promise<CommandResult>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingCommandsRef.current.delete(id);
        resolve({ status: "unknown", reason: "TIMEOUT" });
      }, 8_000);
      pendingCommandsRef.current.set(id, (result: CommandResult) => {
        window.clearTimeout(timeout);
        pendingCommandsRef.current.delete(id);
        resolve(result);
      });
      try {
        ws.send(JSON.stringify({ type: "command", id, command: payload }));
      } catch {
        window.clearTimeout(timeout);
        pendingCommandsRef.current.delete(id);
        resolve({ status: "unknown", reason: "SEND_FAILED" });
      }
    });
  }, []);

  /** 布尔版 sendCommand：非转分命令沿用原语义（true=服务器已确认）。 */
  const sendCommand = useCallback((payload: Record<string, unknown>, options?: { id?: string }): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setNotice("连接已断开，操作未发送");
      return Promise.resolve(false);
    }
    return sendCommandDetailed(payload, options).then((result) => result.status === "confirmed");
  }, [sendCommandDetailed]);


  useEffect(() => {
    // 分享链接格式为 /?invite={邀请码}：主页直接读取参数进入加入流程，
    // 随后用 replaceState 原地清掉地址栏参数，只留下根 URL。
    const bridge = getPlatformBridge();
    const bridgeInvite = bridge?.getInviteCode?.() ?? "";
    const url = bridgeInvite || bridge?.kind === "weapp" ? null : new URL(window.location.href);
    const inviteCode = normalizeRoomId(bridgeInvite || url?.searchParams.get("invite") || "");
    if (bridgeInvite) {
      bridge?.clearInviteCode?.();
    } else if (url?.searchParams.has("invite")) {
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const hasInvite = Boolean(inviteCode && ROOM_ID_PATTERN.test(inviteCode));
    if (hasInvite) {
      setJoinCode(inviteCode);
      setScreen("join");
    }
    const session = readStoredSession();
    // 邀请的房间与本地会话所在房间一致（或无邀请）时，优先用凭证重连，
    // 而不是重新走加入流程，避免被自己的离线/待批准记录挡住。
    const shouldResume = Boolean(
      session
      && ROOM_ID_PATTERN.test(session.roomId)
      && (!hasInvite || session.roomId === inviteCode),
    );
    if (session && shouldResume) {
      sessionRef.current = session;
      stoppedRef.current = false;
      setResuming(true);
      const resumeRoom = async () => {
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(session.roomId)}?playerId=${encodeURIComponent(session.playerId)}`, {
            cache: "no-store",
            headers: { authorization: `Bearer ${session.token}` },
          });
          if (stoppedRef.current) { setResuming(false); return; }
          if (!sameSession(readStoredSession(), session)) { setResuming(false); return; }
          if (response.ok) {
            const info = await response.json().catch(() => null) as { member?: boolean } | null;
            // 房间还在但会话已失效（离线时被踢/申请被拒/主动离开）：清理凭证，不再重连。
            if (info && info.member === false) {
              handleKicked("你已不在该房间");
              return;
            }
            connectSocket(session);
            return;
          }
          sessionRef.current = null;
          clearStoredSession();
          setRoom(null);
          updateSecretCard(null);
          setWsStatus("closed");
          setResuming(false);
          if (hasInvite) {
            // 邀请链接指向的房间已不存在：回首页并明确告知。
            setJoinStep(0);
            setScreen("home");
            setNotice("房间已不存在");
          } else {
            setNotice("上次的房间已结束");
          }
        } catch {
          if (!stoppedRef.current && sameSession(readStoredSession(), session)) {
            connectSocket(session);
          } else {
            setResuming(false);
          }
        }
      };
      void resumeRoom();
    } else if (hasInvite) {
      // 邀请链接直达昵称申请界面，跳过输入邀请码与“继续”按钮；
      // 后台校验房间是否仍存在，不存在则回首页提示。
      setJoinStep(1);
      const checkRoom = async () => {
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(inviteCode)}`, { cache: "no-store" });
          if (stoppedRef.current) return;
          if (!response.ok) {
            setJoinStep(0);
            setScreen("home");
            setNotice("房间已不存在");
          }
        } catch {
          // 网络异常时留在昵称界面，提交申请时再提示。
        }
      };
      void checkRoom();
    }
    const onOnline = () => {
      const current = sessionRef.current;
      if (!current || stoppedRef.current) return;
      // 浏览器明确报告网络恢复时，开启一轮新的退避重试（重置次数，从短间隔开始）。
      reconnectAttemptRef.current = 0;
      setReconnectPhase("retrying");
      connectSocketRef.current(current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onOnline();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      stoppedRef.current = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      try {
        wsRef.current?.close(1000, "bye");
      } catch {
        // Ignore closing errors.
      }
      wsRef.current = null;
    };
  }, [connectSocket, handleKicked, updateSecretCard]);

  // ---------------------------------------------------------------------------
  // 摄像头显式控制器（不依赖 React effect 竞态；切换期间互斥）
  // ---------------------------------------------------------------------------

  const stopActiveCamera = useCallback(async () => {
    const current = streamRef.current;
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    current?.getTracks().forEach((track) => track.stop());
    // 部分移动设备需要短暂时间释放 Camera2 资源，再请求下一个镜头。
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }, []);

  const openExactCamera = useCallback(async (deviceId: string, reason: CameraSwitchReason): Promise<boolean> => {
    const sequence = ++openSequenceRef.current;
    switchingRef.current = true;
    await stopActiveCamera();

    // bootstrap 摄像头若正是目标候选，直接复用该流，避免无意义的关闭重开（B037）。
    const bootstrap = bootstrapStreamRef.current;
    const bootstrapTrack = bootstrap?.getVideoTracks().find((track) => track.readyState !== "ended");
    if (bootstrap && bootstrapTrack && bootstrapTrack.getSettings().deviceId === deviceId) {
      try {
        const video = videoRef.current;
        if (video) {
          await bootstrapTrack.applyConstraints({ deviceId: { exact: deviceId } });
          video.srcObject = bootstrap;
          await video.play();
          await waitForFirstVideoFrame(video);
          streamRef.current = bootstrap;
          activeCameraDeviceIdRef.current = deviceId;
          await tuneCameraTrack(bootstrapTrack);
          bootstrapStreamRef.current = null;
          if (process.env.NODE_ENV !== "production") console.log("[camera] reused bootstrap stream", reason);
          switchingRef.current = false;
          return true;
        }
      } catch {
        // 复用失败时按正常流程重新打开。
      }
    }

    const attempts: MediaTrackConstraints[] = [
      {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
      {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      {
        deviceId: { exact: deviceId },
      },
    ];

    for (const constraints of attempts) {
      let candidateStream: MediaStream | null = null;
      try {
        candidateStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
        if (sequence !== openSequenceRef.current) {
          candidateStream.getTracks().forEach((track) => track.stop());
          switchingRef.current = false;
          return false;
        }
        const video = videoRef.current;
        if (!video) {
          candidateStream.getTracks().forEach((track) => track.stop());
          switchingRef.current = false;
          return false;
        }
        video.srcObject = candidateStream;
        await video.play();
        await waitForFirstVideoFrame(video);
        streamRef.current = candidateStream;
        const track = candidateStream.getVideoTracks()[0];
        activeCameraDeviceIdRef.current = track?.getSettings().deviceId ?? null;
        await tuneCameraTrack(track);
        // 生产构建不输出 deviceId / 摄像头完整信息（B038）。
        if (process.env.NODE_ENV !== "production") {
          console.log("[camera] opened", { switchReason: reason, label: candidateDevicesRef.current.find((device) => device.deviceId === deviceId)?.label ?? "(unknown)" });
        }
        switchingRef.current = false;
        return true;
      } catch {
        candidateStream?.getTracks().forEach((track) => track.stop());
        if (videoRef.current && videoRef.current.srcObject === candidateStream) {
          videoRef.current.srcObject = null;
        }
        // 尝试下一组约束更少的配置。
      }
    }
    switchingRef.current = false;
    return false;
  }, [stopActiveCamera]);

  const openFallbackCamera = useCallback(async (reason: CameraSwitchReason): Promise<boolean> => {
    const sequence = ++openSequenceRef.current;
    switchingRef.current = true;
    await stopActiveCamera();
    let candidateStream: MediaStream | null = null;
    try {
      candidateStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (sequence !== openSequenceRef.current) {
        candidateStream.getTracks().forEach((track) => track.stop());
        switchingRef.current = false;
        return false;
      }
      const video = videoRef.current;
      if (!video) {
        candidateStream.getTracks().forEach((track) => track.stop());
        switchingRef.current = false;
        return false;
      }
      video.srcObject = candidateStream;
      await video.play();
      await waitForFirstVideoFrame(video);
      streamRef.current = candidateStream;
      const track = candidateStream.getVideoTracks()[0];
      activeCameraDeviceIdRef.current = track?.getSettings().deviceId ?? null;
      activeCandidateIndexRef.current = -1;
      await tuneCameraTrack(track);
      if (process.env.NODE_ENV !== "production") {
        console.log("[camera] opened", { switchReason: reason, label: "(browser default)" });
      }
      switchingRef.current = false;
      return true;
    } catch {
      candidateStream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current && videoRef.current.srcObject === candidateStream) {
        videoRef.current.srcObject = null;
      }
      switchingRef.current = false;
      return false;
    }
  }, [stopActiveCamera]);
  const openFirstWorkingCandidate = useCallback(async (startIndex: number, reason: CameraSwitchReason): Promise<boolean> => {
    const ids = candidateDevicesRef.current.map((device) => device.deviceId);
    if (ids.length === 0) return openFallbackCamera(reason);
    for (let offset = 0; offset < ids.length; offset += 1) {
      const index = (startIndex + offset) % ids.length;
      const ok = await openExactCamera(ids[index], reason);
      if (ok) {
        activeCandidateIndexRef.current = index;
        return true;
      }
    }
    // 所有具体候选都打不开，最后才允许回退浏览器默认摄像头。
    return openFallbackCamera(reason);
  }, [openExactCamera, openFallbackCamera]);

  const handleScanSuccess = useCallback((value: string) => {
    const track = streamRef.current?.getVideoTracks()[0];
    const deviceId = track?.getSettings().deviceId;
    if (deviceId) {
      storePreferredCamera(deviceId, track.label);
      if (process.env.NODE_ENV !== "production") console.log("[camera] remembering preferred camera");
    }
    // 先走统一退出动画，再与手动输入邀请码走同一条验证路径（F008/F010）。
    void closeScannerRef.current("scan").then(() => {
      void verifyJoinCodeRef.current(value);
    });
  }, []);

  const enterCameraPhase = useCallback(async (phase: CameraPhase, duration = 0) => {
    setCameraPhase(phase);
    // 保证这个状态真的被浏览器绘制过，防止 React 在同一帧内跳过中间状态。
    await waitForPaint();
    if (duration > 0) {
      await delay(duration);
    }
  }, []);

  // 扫码/手动输入统一校验：验证房间存在后直接进入昵称步骤（F008）。
  const verifyJoinCode = useCallback(async (rawCode: string): Promise<boolean> => {
    const roomId = normalizeRoomId(extractInviteCode(rawCode));
    setJoinCode(roomId);
    if (!ROOM_ID_PATTERN.test(roomId)) {
      setNotice("未识别到有效的房间邀请码");
      return false;
    }
    setCheckingJoin(true);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { cache: "no-store" });
      if (!response.ok) {
        setNotice(await apiError(response, "房间不存在或已结束"));
        return false;
      }
      setJoinStep(1);
      setNotice("已读取邀请");
      return true;
    } catch {
      // 网络异常时留在昵称界面，提交申请时再提示。
      setJoinStep(1);
      return true;
    } finally {
      setCheckingJoin(false);
    }
  }, []);

  // 统一关闭扫码器：画面收合 -> 遮罩淡出 -> 停止摄像头（F010）。
  const closeScanner = useCallback(async (reason: "button" | "scan" | "image") => {
    if (!cameraOpen || cameraClosing || cameraPhase.includes("closing")) return;
    try {
      await enterCameraPhase("pre-closing", 100);
      await enterCameraPhase("picture-closing", 260);
      setCameraPhase("line-closing");
      setCameraClosing(true);
      await delay(220);
    } finally {
      await stopActiveCamera();
      setCameraOpen(false);
      setCameraPhase("closed");
      setCameraClosing(false);
    }
  }, [cameraOpen, cameraClosing, cameraPhase, enterCameraPhase, stopActiveCamera]);

  // 打开扫码页：bootstrap 拿权限 → 枚举 → 排序 → 打开首选。

  useEffect(() => {
    if (!cameraOpen) return;
    const videoEl = videoRef.current;
    let cancelled = false;
    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera-unavailable");
        // 1) bootstrap：只请求最小约束拿权限，不显示预览，避免先闪出默认长焦画面。
        const bootstrapStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          bootstrapStream.getTracks().forEach((track) => track.stop());
          return;
        }
        // 先不停止 bootstrap 流：若首选候选就是该镜头则直接复用（B037）。
        bootstrapStreamRef.current = bootstrapStream;
        const bootstrapDeviceId = bootstrapStream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

        // 2) 权限已授予，重新枚举可拿到带标签的完整设备列表。
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((device) => device.kind === "videoinput");
        if (process.env.NODE_ENV !== "production") {
          console.log("[camera] video devices:", videoDevices.map((device) => ({ label: device.label })));
        }

        const rearCandidates = rearCameraCandidates(videoDevices);
        const preferred = readPreferredCamera();
        let preferredId: string | null = null;
        if (preferred) {
          if (videoDevices.some((device) => device.deviceId === preferred.deviceId)) {
            preferredId = preferred.deviceId;
          } else {
            // 保存的设备已不存在：清除记录并重新探测。
            clearPreferredCamera();
          }
        }
        const sorted = sortCameraCandidates(rearCandidates, preferredId, bootstrapDeviceId);
        candidateDevicesRef.current = sorted;
        activeCandidateIndexRef.current = -1;

        if (process.env.NODE_ENV !== "production") {
          console.log("[camera] candidates:", sorted.map((device) => ({ label: device.label, score: cameraScore(device, preferredId, bootstrapDeviceId) })));
        }
        setCameraSwitchVisible(sorted.length > 1);

        // 3) 打开首选候选；打不开就逐个尝试其他候选，最后才允许回退默认。
        const opened = await openFirstWorkingCandidate(0, preferredId ? "preferred" : "heuristic");
        if (cancelled) {
          bootstrapStreamRef.current?.getTracks().forEach((track) => track.stop());
          bootstrapStreamRef.current = null;
          return;
        }
        if (!opened) {
          bootstrapStreamRef.current?.getTracks().forEach((track) => track.stop());
          bootstrapStreamRef.current = null;
          setCameraPhase("error");
          setCameraMessage("相机不可用，请手动输入邀请码");
          return;
        }
        bootstrapStreamRef.current = null;
        // 1. 只展开横线
        await enterCameraPhase("line-opening", 280);
        if (cancelled) return;
        // 2. 再展开画面
        await enterCameraPhase("picture-opening", 460);
        if (cancelled) return;
        // 3. 最后显示扫描界面
        await enterCameraPhase("ready");
        setCameraMessage("将二维码完整放入取景框");
      } catch {
        setCameraPhase("error");
        setCameraMessage("相机不可用，请手动输入邀请码");
      }
    };
    void startCamera();
    return () => {
      cancelled = true;
      openSequenceRef.current += 1; // 使进行中的打开请求失效
      bootstrapStreamRef.current?.getTracks().forEach((track) => track.stop());
      bootstrapStreamRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoEl) videoEl.srcObject = null;
    };
  }, [cameraOpen, openFirstWorkingCandidate, enterCameraPhase]);

  // 持续扫码：只在 ready 阶段运行（F009），原生 BarcodeDetector 每帧优先，
  // jsQR 每 3 帧补充执行（B034）。
  useEffect(() => {
    if (!cameraOpen || cameraPhase !== "ready") return;
    let cancelled = false;
    let timer = 0;
    let frameIndex = 0;
    const detector = createBarcodeDetector();
    const startedAt = Date.now();
    const loop = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        timer = window.setTimeout(loop, 300);
        return;
      }
      frameIndex += 1;
      const value = await decodeVideoFrame(video, detector, frameIndex);
      if (cancelled) return;
      if (value) {
        if (process.env.NODE_ENV !== "production") console.log("[camera] decode succeeded, timeToDecodeMs:", Date.now() - startedAt);
        handleScanSuccess(value);
        return;
      }
      timer = window.setTimeout(loop, 500);
    };
    void loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cameraOpen, cameraPhase, handleScanSuccess]);

  const inviteUrl = useMemo(() => (room ? makeInviteUrl(room) : ""), [room]);
  useEffect(() => {
    getPlatformBridge()?.setShareRoomId?.(room?.roomId ?? "");
  }, [room?.roomId]);
  const currentPlayer = room?.players.find((player) => player.id === room.localPlayerId) ?? null;
  const connectedCount = room?.players.filter((player) => player.online).length ?? 0;
  const isHost = Boolean(room && room.localPlayerId && room.hostId === room.localPlayerId);

  useEffect(() => {
    if (getPlatformBridge()?.kind === "weapp") return;
    if (screen !== "lobby" || !inviteUrl || !qrCanvas) return;
    QRCode.toCanvas(qrCanvas, inviteUrl, {
      width: 168,
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#102033", light: "#f5ebdd" },
    }).catch(() => setNotice("二维码生成失败，请直接复制邀请链接"));
  }, [inviteUrl, screen, qrCanvas]);

  const enterGame = (gameId: GameId) => {
    void sendCommand({ type: "enter-game", gameId }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const startUndercoverGame = () => {
    void sendCommand({ type: "undercover-start" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const startChallengeGame = () => {
    void sendCommand({ type: "challenge-start" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const backToLobby = () => {
    // 房主先选择“暂时离开”或“结束游戏”，不直接清空对局。
    setLeaveGameDialog(true);
  };

  const closeLeaveGameDialog = () => {
    setLeaveGameDialog(false);
    setEndGameArmed(false);
  };

  const hostTemporarilyLeave = () => {
    setLeaveGameDialog(false);
    setEndGameArmed(false);
    void sendCommand({ type: "host-temporary-leave" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const handleEndGameClick = () => {
    // 两步确认：第一次点击只进入待确认（高亮），再点一次才真正结束游戏。
    if (!endGameArmed) {
      setEndGameArmed(true);
      // armed 状态 3 秒后自动过期（F013）。
      if (armedExpireRef.current) window.clearTimeout(armedExpireRef.current);
      armedExpireRef.current = window.setTimeout(() => {
        setEndGameArmed(false);
        armedExpireRef.current = undefined;
      }, 3000);
      return;
    }
    setEndGameArmed(false);
    setLeaveGameDialog(false);
    void sendCommand({ type: "back-to-lobby" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const returnToGame = () => {
    void sendCommand({ type: "host-return-game" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const endGameFromLobby = () => {
    handleEndGameClick();
  };

  const startUndercoverFlip = () => {
    if (!flipToggledRef.current) {
      flipToggledRef.current = true;
      setFlipRight((current) => !current);
    }
    setCardRevealed(true);
  };

  const closeUndercoverCard = () => {
    flipToggledRef.current = false;
    setCardRevealed(false);
  };


  const toggleVoteReady = () => {
    const game = roomRef.current?.game;
    const playerId = roomRef.current?.localPlayerId;
    if (!game || game.kind !== "undercover" || !playerId) return;
    void sendCommand({
      type: "vote-ready",
      ready: !game.voteReadyPlayerIds.includes(playerId),
    }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const submitVote = useCallback((targetId: string) => {
    if (!targetId) return;
    // ACK 成功后才标记“已投票”，避免假成功（F004）。
    void sendCommand({ type: "vote", targetId }).then((ok) => {
      if (ok) {
        setConfirmedVote(targetId);
      } else {
        setNotice("投票发送失败，请重试");
      }
    });
  }, [sendCommand]);

  const handleVoteAvatarClick = useCallback((playerId: string) => {
    if (!currentPlayer) return;
    if (voteTarget === playerId) {
      // 再次点击已选中的头像 -> 确认投票
      submitVote(playerId);
    } else {
      setVoteTarget(playerId);
    }
  }, [voteTarget, currentPlayer, submitVote]);

  // 玩家列表点击事件委托：由 data 属性判断点中的行是否可投票，避免渲染期创建内联回调。
  const handlePlayerListClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentPlayer) return;
    // 长按踢人成功后抑制同一次点击触发的投票（F015）。
    if (suppressAvatarClickRef.current) {
      suppressAvatarClickRef.current = false;
      return;
    }
    const row = (event.target as HTMLElement).closest("[data-player-id]") as HTMLElement | null;
    const playerId = row?.dataset.playerId ?? "";
    if (!playerId || row?.dataset.votable !== "true") return;
    handleVoteAvatarClick(playerId);
  }, [handleVoteAvatarClick, currentPlayer]);

  const toggleNextRoundReady = () => {
    const game = roomRef.current?.game;
    const playerId = roomRef.current?.localPlayerId;
    if (!game || game.kind !== "undercover" || !playerId) return;
    void sendCommand({
      type: "next-round-ready",
      ready: !game.nextRoundReadyPlayerIds.includes(playerId),
    }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const continueUndercoverRound = () => {
    // “继续”只关闭自己本地的投票结果页，不通知服务端。
    dismissedVoteResultKeyRef.current = pendingVoteResult?.key ?? null;
    setPendingVoteResult(null);
  };

  const updateUndercoverSettings = (changes: Partial<UndercoverSettings>) => {
    const game = roomRef.current?.game;
    if (!isHost || !game || game.kind !== "undercover") return;
    void sendCommand({ type: "undercover-settings", settings: { ...game.settings, ...changes } })
      .then((ok) => { if (!ok) setNotice("连接已断开，设置未保存"); });
  };

  const penalizeChallenge = (targetId: string) => {
    void sendCommand({ type: "challenge-penalize", playerId: targetId }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const dismissLostCardReveal = async () => {
    const reveal = challengeReveal;
    if (!reveal) return;
    const ok = await sendCommand({ type: "challenge-lost-card-dismiss", eventId: reveal.key });
    if (ok) {
      setChallengeReveal(null);
    } else {
      setNotice("连接已断开，请重试");
    }
  };

  const swapChallenge = (targetId: string) => {
    void sendCommand({ type: "challenge-swap", playerId: targetId }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const rewardChallenge = (targetId: string) => {
    void sendCommand({ type: "challenge-reward", playerId: targetId }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const restartChallenge = () => {
    void sendCommand({ type: "challenge-restart" }).then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const updateChallengeSettings = (changes: Partial<ChallengeSettings>) => {
    const game = roomRef.current?.game;
    if (!isHost || !game || game.kind !== "challenge") return;
    void sendCommand({ type: "challenge-settings", settings: { ...game.settings, ...changes } })
      .then((ok) => { if (!ok) setNotice("连接已断开，设置未保存"); });
  };

  const clearTransferRaf = useCallback(() => {
    if (transferRafRef.current !== undefined) {
      window.cancelAnimationFrame(transferRafRef.current);
      transferRafRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    return () => clearTransferRaf();
  }, [clearTransferRaf]);

  const finishTransferClose = useCallback(() => {
    clearTransferRaf();

    setMahjongTarget("");
    setMahjongPoints("");
    setMahjongAdjusting(false);
    setMahjongRipple(null);
    setTransferMode("give");
    setMahjongCollectPoints("");
    setTransferPhase("closed");
  }, [clearTransferRaf]);

  // 面板第一次挂载，或收起途中重新打开时，测量子卡片完整高度并展开空间。
  useLayoutEffect(() => {
    if (transferPhase !== "preparing") return;

    const slot = transferSlotRef.current;
    const stage = transferStageRef.current;

    if (!slot || !stage) return;

    clearTransferRaf();

    const currentHeight = slot.getBoundingClientRect().height;

    slot.style.height = `${currentHeight}px`;
    slot.style.overflow = "hidden";

    // 强制浏览器提交起始高度。
    void slot.offsetHeight;

    transferRafRef.current = window.requestAnimationFrame(() => {
      transferRafRef.current = undefined;

      setTransferPhase("expanding");
      slot.style.height = `${stage.scrollHeight}px`;
    });
  }, [transferPhase, mahjongTarget, clearTransferRaf]);

  // 目标玩家在展开途中改变时，更新目标高度，避免昵称换行造成高度不准确。
  useLayoutEffect(() => {
    if (transferPhase !== "expanding") return;

    const slot = transferSlotRef.current;
    const stage = transferStageRef.current;

    if (!slot || !stage) return;

    slot.style.height = `${stage.scrollHeight}px`;
  }, [transferPhase, mahjongTarget]);

  const beginTransferCollapse = useCallback(() => {
    const slot = transferSlotRef.current;

    clearTransferRaf();

    if (!slot) {
      finishTransferClose();
      return;
    }

    const currentHeight = slot.getBoundingClientRect().height;

    if (currentHeight < 1) {
      finishTransferClose();
      return;
    }

    slot.style.height = `${currentHeight}px`;
    slot.style.overflow = "hidden";

    void slot.offsetHeight;

    transferRafRef.current = window.requestAnimationFrame(() => {
      transferRafRef.current = undefined;

      setTransferPhase("collapsing");
      slot.style.height = "0px";
    });
  }, [clearTransferRaf, finishTransferClose]);

  const closeMahjongTransfer = useCallback(() => {
    // 发送/重试期间锁定面板（整笔生命周期），防止收起后再次打开出现空输入。
    if (transferLockedRef.current) return;
    // 关闭面板时同步让数字键盘滑出。
    closeMahjongKeypad();

    if (
      transferPhase === "closed" ||
      transferPhase === "exiting" ||
      transferPhase === "collapsing"
    ) {
      return;
    }

    // 子卡片还没出现时直接反向收起空间，不需要播放看不见的退出动画。
    if (
      transferPhase === "preparing" ||
      transferPhase === "expanding"
    ) {
      beginTransferCollapse();
      return;
    }

    // 先让子卡片整体退出。
    setTransferPhase("exiting");
  }, [transferPhase, beginTransferCollapse, closeMahjongKeypad]);

  const handleTransferSlotTransitionEnd = (
    event: React.TransitionEvent<HTMLDivElement>,
  ) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "height"
    ) {
      return;
    }

    const slot = event.currentTarget;

    if (transferPhase === "expanding") {
      // 展开结束后恢复 auto，后续昵称换行、字体变化、屏幕旋转都能自然适配。
      slot.style.height = "auto";
      slot.style.overflow = "visible";

      // 此时空间完整，子卡片再整体进入。
      setTransferPhase("entering");
      return;
    }

    if (transferPhase === "collapsing") {
      finishTransferClose();
    }
  };

  // 子卡片出现时，如果其底部低于屏幕底部 10% 的位置，则平滑上移。
  useLayoutEffect(() => {
    if (transferPhase !== "entering" && transferPhase !== "open") return;
    const slot = transferSlotRef.current;
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    const targetBottom = window.innerHeight * 0.9;
    if (rect.bottom > targetBottom) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + (rect.bottom - targetBottom)),
        behavior: "smooth",
      });
    }
  }, [transferPhase, mahjongTarget]);

  const handleTransferPanelTransitionEnd = (
    event: React.TransitionEvent<HTMLDivElement>,
  ) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "opacity"
    ) {
      return;
    }

    if (transferPhase === "entering") {
      setTransferPhase("open");
      return;
    }

    if (transferPhase === "exiting") {
      // 子卡片已经不可见，再收起外层空间。
      beginTransferCollapse();
    }
  };

  const selectMahjongTarget = (playerId: string) => {
    if (!room) return;
    if (transferLockedRef.current) {
      setNotice("上一笔转分结果尚未确认，请稍候");
      return;
    }
    // 从“向所有人收取”切到普通给分：换内容并重新测量高度。
    const switchingFromCollect = transferMode === "collect" && transferPhase !== "closed";
    setTransferMode("give");
    if (switchingFromCollect) {
      closeMahjongKeypad();
      setMahjongTarget(playerId);
      setTransferPhase("preparing");
      return;
    }
    // 自己的牌已被禁用，不会触发；此处仅处理取消选中。
    if (playerId === mahjongTarget) {
      closeMahjongTransfer();
      return;
    }
    setMahjongTarget(playerId);
    if (transferPhase === "closed" || transferPhase === "collapsing") {
      setTransferPhase("preparing");
      return;
    }
    // 退出过程中选择另一个玩家：取消退出，从当前透明度平滑恢复。
    if (transferPhase === "exiting") {
      setTransferPhase("open");
    }
    // 已经打开时只修改玩家名字，不重播进场动画。
  };

  // 转分自动重试：结果未知时用同一个 operationId 继续，服务端幂等去重（P0-04 加固）。
  const runTransferAttemptRef = useRef<((operation: PersistedTransfer, attempts: number) => Promise<void>) | null>(null);
  const scheduleTransferRetry = useCallback((operation: PersistedTransfer, attempts: number) => {
    if (transferRetryTimerRef.current !== undefined) window.clearTimeout(transferRetryTimerRef.current);
    const delay = TRANSFER_RETRY_BACKOFF_MS[Math.min(attempts - 1, TRANSFER_RETRY_BACKOFF_MS.length - 1)];
    transferRetryTimerRef.current = window.setTimeout(() => {
      transferRetryTimerRef.current = undefined;
      if (transferBusyRef.current) return;
      void runTransferAttemptRef.current?.(operation, attempts);
    }, delay);
  }, []);

  const runTransferAttempt = useCallback(async (operation: PersistedTransfer, attempts: number) => {
    // 发送/重试全程持有同步锁，锁定输入、目标与面板。
    transferBusyRef.current = true;
    transferLockedRef.current = true;
    setTransferState((current) => {
      if (current.phase === "idle" || current.phase === "rejected") {
        return { phase: "sending", operationId: operation.operationId, targetId: operation.targetId, targetName: operation.targetName, points: operation.points, attempts };
      }
      if (current.phase === "sending" || current.phase === "retrying") {
        if (current.operationId === operation.operationId) return { ...current, attempts };
      }
      return current;
    });
    const result = await sendCommandDetailed(
      { type: "mahjong-transfer", operationId: operation.operationId, targetId: operation.targetId, points: operation.points },
      { id: operation.operationId },
    );
    if (result.status === "confirmed") {
      // 只处理当前这一笔：晚到 ACK 不得清空其它操作的状态（双保险）。
      if (pendingTransferRef.current?.operationId !== operation.operationId) return;
      transferBusyRef.current = false;
      transferLockedRef.current = false;
      pendingTransferRef.current = null;
      removeTransferFromOutbox(operation.operationId);
      stopTransferWarnTimers();
      setTransferState({ phase: "idle" });
      setMahjongPoints("");
      setNotice("分数已给出");
      if (transferPhaseRef.current === "closed") {
        // 面板未打开（例如刷新后恢复、或处于结账阶段）：直接复位，避免残留选中态。
        setMahjongTarget("");
      } else {
        closeMahjongTransfer();
      }
      return;
    }
    if (result.status === "rejected") {
      transferBusyRef.current = false;
      transferLockedRef.current = false;
      pendingTransferRef.current = null;
      removeTransferFromOutbox(operation.operationId);
      const errorText =
        result.error === "FORBIDDEN"
          ? "没有权限执行该操作"
          : result.error === "CONFLICT"
            ? "操作编号冲突，请重新提交"
            : "操作无效，请检查后重新提交";
      stopTransferWarnTimers();
      setTransferState({ phase: "rejected", targetId: operation.targetId, targetName: operation.targetName, points: operation.points, error: errorText });
      setNotice(`未发送：${errorText}`);
      return;
    }
    // 结果未知（超时/断线/发送失败）：保持锁定，自动用同一 operationId 重试。
    setTransferState((current) =>
      current.phase === "sending" || current.phase === "retrying"
        ? { ...current, phase: "retrying", attempts }
        : current,
    );
    transferBusyRef.current = false;
    scheduleTransferRetry(operation, attempts + 1);
  }, [scheduleTransferRetry, sendCommandDetailed, closeMahjongTransfer, stopTransferWarnTimers]);
  useEffect(() => {
    runTransferAttemptRef.current = runTransferAttempt;
  }, [runTransferAttempt]);

  // 连接恢复后立即重试未确认的转分，不必等退避计时器。
  const nudgeTransferRetry = useCallback(() => {
    if (transferBusyRef.current) return;
    const operation = pendingTransferRef.current;
    if (!operation) return;
    if (transferRetryTimerRef.current !== undefined) window.clearTimeout(transferRetryTimerRef.current);
    transferRetryTimerRef.current = undefined;
    void runTransferAttemptRef.current?.(
      {
        roomId: roomRef.current?.roomId ?? "",
        playerId: roomRef.current?.localPlayerId ?? "",
        operationId: operation.operationId,
        targetId: operation.targetId,
        targetName: operation.targetName,
        points: operation.points,
      },
      1,
    );
  }, []);
  useEffect(() => {
    nudgeTransferRetryRef.current = nudgeTransferRetry;
  }, [nudgeTransferRetry]);

  // 页面刷新/系统回收后：从本地 outbox 恢复未确认的转分并自动重试。
  useEffect(() => {
    if (!room || transferState.phase !== "idle") return;
    const pending = readTransferOutbox().find(
      (entry) => entry.roomId === room.roomId && entry.playerId === room.localPlayerId,
    );
    if (!pending) return;
    // 延迟到下一帧执行，避免 effect 内同步 setState 造成级联渲染。
    const frame = window.requestAnimationFrame(() => {
      pendingTransferRef.current = {
        operationId: pending.operationId,
        targetId: pending.targetId,
        targetName: pending.targetName,
        points: pending.points,
      };
      setMahjongTarget(pending.targetId);
      setMahjongPoints(String(pending.points));
      setTransferPhase((phase) => (phase === "closed" || phase === "collapsing" ? "preparing" : phase));
      setTransferState({ phase: "retrying", operationId: pending.operationId, targetId: pending.targetId, targetName: pending.targetName, points: pending.points, attempts: 1 });
      startTransferWarnTimers();
      void runTransferAttemptRef.current?.(pending, 1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [room, transferState.phase, startTransferWarnTimers]);

  const sendMahjongTransfer = async (targetId: string) => {
    // 发送/重试期间锁定：不创建新操作，防止同帧连点或修改为另一笔（P0-04 加固）。
    if (transferLockedRef.current) return;
    if (transferState.phase === "sending" || transferState.phase === "retrying") return;
    if (!room) return;
    const parsed = parseMahjongPoints(mahjongPoints);
    if (!parsed.ok) {
      setNotice(parsed.error);
      return;
    }
    // 点击发送后无论是否成功都收起小键盘（校验失败时保留键盘便于改正）。
    closeMahjongKeypad();
    const targetName = room.players.find((player) => player.id === targetId)?.name ?? "该玩家";
    const operation: PersistedTransfer = {
      roomId: room.roomId,
      playerId: room.localPlayerId,
      operationId: newUuid(),
      targetId,
      targetName,
      points: parsed.value,
    };
    pendingTransferRef.current = {
      operationId: operation.operationId,
      targetId,
      targetName,
      points: parsed.value,
    };
    // 先落 outbox 再发送：刷新/崩溃后可恢复同一 operationId 重试，不会重复计分。
    saveTransferToOutbox(operation);
    setMahjongTarget(targetId);
    setTransferPhase((phase) => (phase === "closed" || phase === "collapsing" ? "preparing" : phase));
    startTransferWarnTimers();
    void runTransferAttempt(operation, 1);
  };

  // 长按自己的卡片：打开“向所有人收取”面板（450ms 停留判定）。
  const handleSelfTilePointerDown = () => {
    if (transferLockedRef.current || mahjongCollectSendingRef.current) return;
    // 收取面板已打开：再次长按收起。
    if (transferMode === "collect" && transferPhase !== "closed") {
      closeMahjongTransfer();
      return;
    }
    const press = { timer: undefined as number | undefined };
    selfTilePressRef.current = press;
    // 右上角圆圈进度：按下即出现，随长按时间填充。
    setSelfTileRing({ key: Date.now(), phase: "filling" });
    press.timer = window.setTimeout(() => {
      if (selfTilePressRef.current !== press) return;
      selfTileLongPressRef.current = true;
      // 触发：进度圈快速向外扩散消失，同时弹出收取卡片。
      setSelfTileRing((current) => (current ? { ...current, phase: "bursting" } : current));
      setMahjongCollectPoints("");
      closeMahjongKeypad();
      // 复用给分面板的展开动效：切到收取模式并重新测量高度。
      setTransferMode("collect");
      setMahjongTarget("");
      setTransferPhase("preparing");
    }, 450);
  };
  const handleSelfTilePointerUp = () => {
    const press = selfTilePressRef.current;
    if (!press) return;
    if (press.timer !== undefined) window.clearTimeout(press.timer);
    selfTilePressRef.current = null;
    // 长按未触发时收回进度圈；已触发（扩散中）让它播完再消失。
    setSelfTileRing((current) => (current && current.phase === "filling" ? null : current));
  };

  // 发送“向所有人收取”：同一意图复用同一 operationId，服务端幂等去重。
  const sendMahjongCollect = async () => {
    if (mahjongCollectSendingRef.current) return;
    const parsed = parseMahjongPoints(mahjongCollectPoints);
    if (!parsed.ok) {
      setNotice(parsed.error);
      return;
    }
    // 点击发送后无论是否成功都收起小键盘（校验失败时保留键盘便于改正）。
    closeMahjongKeypad();
    let operation = pendingCollectOpRef.current;
    if (!operation || operation.points !== parsed.value) {
      operation = { operationId: newUuid(), points: parsed.value };
      pendingCollectOpRef.current = operation;
    }
    mahjongCollectSendingRef.current = true;
    setMahjongCollectSending(true);
    try {
      const ok = await sendCommand(
        { type: "mahjong-collect", operationId: operation.operationId, points: operation.points },
        { id: operation.operationId },
      );
      if (ok) {
        pendingCollectOpRef.current = null;
        setMahjongCollectPoints("");
        closeMahjongTransfer();
        setNotice("已发起收取，等待其他玩家确认");
      } else {
        setNotice("发送失败，请重试（重复提交不会重复计分）");
      }
    } finally {
      mahjongCollectSendingRef.current = false;
      setMahjongCollectSending(false);
    }
  };

  // 确认/否决一笔收取。
  const voteMahjongCollect = (collectId: string, approve: boolean) => {
    void sendCommand({ type: "mahjong-collect-vote", collectId, approve }).then((ok) => {
      if (!ok) setNotice("操作未发送，请重试");
    });
  };

  // 长按输入框后上下滑动调数：上滑增加、下滑减少。
  const mahjongSwipeRef = useRef<{
    timer: number | undefined;
    active: boolean;
    moved: boolean;
    startY: number;
    lastY: number;
  } | null>(null);

  const openMahjongKeypad = useCallback(() => {
    // 重新打开时清理旧计时器。
    if (mahjongKeypadGuardTimerRef.current !== undefined) window.clearTimeout(mahjongKeypadGuardTimerRef.current);
    if (mahjongKeypadCloseTimerRef.current !== undefined) window.clearTimeout(mahjongKeypadCloseTimerRef.current);
    // 打开时的程序化平滑滚动会被忽略，避免立刻误关键盘。
    mahjongKeypadScrollGuardRef.current = true;
    mahjongKeypadGuardTimerRef.current = window.setTimeout(() => {
      mahjongKeypadGuardTimerRef.current = undefined;
      mahjongKeypadScrollGuardRef.current = false;
    }, 700);
    // 记录打开前的页面滚动位置，关闭后恢复。
    mahjongKeypadOpenScrollYRef.current = window.scrollY;
    mahjongKeypadRestoreScrollRef.current = true;
    setMahjongKeypadClosing(false);
    setMahjongKeypadOpen(true);
  }, []);

  // 键盘打开时，用户滚动页面则自动收起。
  useEffect(() => {
    if (!mahjongKeypadOpen) return;
    const onScroll = () => {
      if (mahjongKeypadScrollGuardRef.current) return;
      // 用户主动滚动收起键盘：不恢复滚动位置。
      mahjongKeypadRestoreScrollRef.current = false;
      closeMahjongKeypad();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [mahjongKeypadOpen, closeMahjongKeypad]);

  // 进入结账后自动滚动，让结算方案卡片接近视觉中心。
  useLayoutEffect(() => {
    const game = room?.game;
    if (game?.kind !== "mahjong" || game.phase !== "SETTLING" || !game.settlement) {
      mahjongSettleScrolledRef.current = false;
      return;
    }
    if (mahjongSettleScrolledRef.current) return;
    mahjongSettleScrolledRef.current = true;
    const settleEl = document.querySelector(".mahjong-settle");
    if (!settleEl) return;
    const rect = settleEl.getBoundingClientRect();
    const targetCenter = window.innerHeight * 0.45;
    const delta = (rect.top + rect.height / 2) - targetCenter;
    if (Math.abs(delta) > 4) {
      window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: "smooth" });
    }
  }, [room]);

  // 数字键盘弹出后，把输入框平滑滚动到键盘上方并接近视觉中心。
  useLayoutEffect(() => {
    if (!mahjongKeypadOpen) return;
    const input = document.querySelector(".mahjong-points-input");
    if (!input) return;
    const keypad = mahjongKeypadRef.current;
    const keypadHeight = keypad?.offsetHeight ?? 240;
    const keypadTop = window.innerHeight - keypadHeight;
    const inputRect = input.getBoundingClientRect();
    const inputCenter = inputRect.top + inputRect.height / 2;
    const targetCenter = keypadTop * 0.6;
    const delta = inputCenter - targetCenter;
    if (Math.abs(delta) > 2) {
      window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: "smooth" });
    }
  }, [mahjongKeypadOpen]);

  // 给分/收取共用的输入值 setter：按当前面板模式决定写哪个状态。
  const activePointsSetter = transferMode === "collect" ? setMahjongCollectPoints : setMahjongPoints;

  const mahjongKeypadAppend = (digit: string) => {
    if (transferLockedRef.current || mahjongCollectSendingRef.current) return;
    activePointsSetter((prev) => {
      const base = prev === "0" ? "" : prev;
      const next = base + digit;
      return next.length <= 5 ? next : prev;
    });
  };

  const mahjongKeypadBackspace = () => {
    if (transferLockedRef.current || mahjongCollectSendingRef.current) return;
    activePointsSetter((prev) => prev.slice(0, -1));
  };

  // 删除键长按连续删除。
  const handleKeypadBackspaceDown = () => {
    mahjongKeypadBackspace();
    if (mahjongBackspaceTimerRef.current !== undefined) return;
    // 长按先停顿 300ms，再以每 125ms 一位的节奏连续删除。
    mahjongBackspaceTimerRef.current = window.setTimeout(() => {
      mahjongBackspaceTimerRef.current = window.setInterval(() => {
        activePointsSetter((prev) => prev.slice(0, -1));
      }, 125);
    }, 300);
  };

  const handleKeypadBackspaceUp = () => {
    stopMahjongKeypadBackspace();
  };

  const handleMahjongPointsPointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    // 发送/重试期间锁定输入（整笔生命周期）：不弹键盘、不进入滑动调数。
    if (transferLockedRef.current || mahjongCollectSendingRef.current) return;
    // 触摸输入：阻止浏览器聚焦、弹出系统键盘与显示光标，
    // 避免长按调数被文本选择打断（不依赖 matchMedia(pointer:fine) 误判）。
    if (event.pointerType === "touch") {
      event.preventDefault();
    }
    const previous = mahjongSwipeRef.current;
    if (previous?.timer) window.clearTimeout(previous.timer);
    const el = event.currentTarget;
    const startY = event.clientY;
    const swipe = { timer: undefined as number | undefined, active: false, moved: false, startY, lastY: startY };
    mahjongSwipeRef.current = swipe;
    setMahjongRipple(null);
    setMahjongAdjusting(false);
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // 不支持指针捕获的环境仍可正常输入。
    }
    swipe.timer = window.setTimeout(() => {
      if (mahjongSwipeRef.current !== swipe) return;
      swipe.active = true;
      swipe.moved = false;
      swipe.lastY = swipe.startY;
      // 进入滑动调数：给出涟漪提示、保持静态高亮、移除输入框聚焦；
      // 已有数字则从当前数字开始，输入框为空时才从 0 开始。
      setMahjongRipple({ key: Date.now(), phase: "activate" });
      setMahjongKeypadOpen(false);
      setMahjongKeypadClosing(false);
      setMahjongAdjusting(true);
      activePointsSetter((prev) => (prev === "" ? "0" : prev));
      try {
        el.blur();
      } catch {
        // 忽略失焦失败。
      }
    }, 450);
  };

  const handleMahjongPointsPointerMove = (event: React.PointerEvent<HTMLInputElement>) => {
    const swipe = mahjongSwipeRef.current;
    if (!swipe) return;
    if (Math.abs(event.clientY - swipe.startY) > 6) swipe.moved = true;
    if (!swipe.active) {
      if (swipe.timer) {
        window.clearTimeout(swipe.timer);
        swipe.timer = undefined;
      }
      return;
    }
    // 步长按屏幕竖直分辨率的 5% 计算，适配不同分辨率。
    const step = window.innerHeight * 0.05;
    const delta = swipe.lastY - event.clientY; // 上滑为正
    const steps = Math.floor(delta / step);
    if (steps !== 0) {
      swipe.lastY -= steps * step;
      activePointsSetter((prev) => {
        const current = prev === "" ? 0 : Number(prev);
        const base = Number.isNaN(current) ? 0 : current;
        return String(Math.max(0, Math.min(99999, base + steps)));
      });
    }
  };

  const handleMahjongPointsPointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    const swipe = mahjongSwipeRef.current;
    if (!swipe) return;
    if (swipe.timer) window.clearTimeout(swipe.timer);
    mahjongSwipeRef.current = null;
    if (swipe.active) {
      event.preventDefault();
      setMahjongRipple({ key: Date.now(), phase: "release" });
      setMahjongAdjusting(false);
      // 松手时数值仍为 0，则自动清空。
      activePointsSetter((prev) => (prev === "0" ? "" : prev));
    } else if (!swipe.moved && event.pointerType === "touch") {
      // 触屏普通单击：打开网页内数字键盘；鼠标/触控笔保持原生输入。
      openMahjongKeypad();
    }
  };

  const handleMahjongPointsPointerCancel = () => {
    const swipe = mahjongSwipeRef.current;
    if (swipe?.timer) window.clearTimeout(swipe.timer);
    mahjongSwipeRef.current = null;
    if (swipe?.active) {
      setMahjongRipple({ key: Date.now(), phase: "release" });
      setMahjongAdjusting(false);
    }
  };

  // 给分/收取面板打开时，点击其它区域即取消（两种模式共用同一收起动效）。
  useEffect(() => {
    const panelOpen = Boolean(mahjongTarget) || (transferMode === "collect" && transferPhase !== "closed");
    if (!panelOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".mahjong-transfer") || target?.closest(".mahjong-tile") || target?.closest(".mahjong-keypad") || target?.closest(".mahjong-collect-area")) return;
      closeMahjongTransfer();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mahjongTarget, transferMode, transferPhase, closeMahjongTransfer]);

  const toggleMahjongResetReady = () => {
    const game = roomRef.current?.game;
    const playerId = roomRef.current?.localPlayerId;
    if (!game || game.kind !== "mahjong" || !playerId) return;
    void sendCommand({ type: "mahjong-reset-ready", ready: !game.resetReadyPlayerIds.includes(playerId) })
      .then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };

  const toggleMahjongSettleReady = () => {
    const game = roomRef.current?.game;
    const playerId = roomRef.current?.localPlayerId;
    if (!game || game.kind !== "mahjong" || !playerId) return;
    void sendCommand({ type: "mahjong-settle-ready", ready: !game.settleReadyPlayerIds.includes(playerId) })
      .then((ok) => { if (!ok) setNotice("连接已断开，操作未发送"); });
  };


  // 新玩家行落地后的弹出动效：设置 just-joined 并定时清除。
  const flashJustJoined = useCallback((playerId: string) => {
    setJustJoinedId(playerId);
    if (justJoinedTimerRef.current) window.clearTimeout(justJoinedTimerRef.current);
    justJoinedTimerRef.current = window.setTimeout(() => {
      setJustJoinedId((prev) => (prev === playerId ? null : prev));
    }, 1000);
  }, []);

  // 飞行头像落地（或超时兜底）：隐藏中的玩家行播放弹出动效。
  const completeIncomingJoin = useCallback((playerId: string) => {
    if (flightFallbackTimerRef.current) window.clearTimeout(flightFallbackTimerRef.current);
    flightFallbackTimerRef.current = undefined;
    if (joinFlightRef.current?.id === playerId) {
      joinFlightRef.current = null;
      setJoinFlight(null);
    }
    if (incomingRef.current === playerId) {
      incomingRef.current = null;
      setIncomingId(null);
    }
    flashJustJoined(playerId);
  }, [flashJustJoined]);

  // 申请行退场：先播放收起动画，动画结束（或超时）后从 DOM 移除。
  const beginRequestExit = useCallback((targetId: string, targetName: string, avatarData?: string) => {
    setLeavingRequests((prev) => (prev.some((item) => item.id === targetId) ? prev : [...prev, { id: targetId, playerName: targetName, ...(avatarData ? { avatarData } : {}) }]));
    window.setTimeout(() => {
      setLeavingRequests((prev) => prev.filter((item) => item.id !== targetId));
    }, 2000);
  }, []);

  // 记录申请列表头像的位置，生成一个“飞向玩家列表”的飞行头像。
  const startJoinFlight = useCallback((targetId: string, targetName: string, avatarData?: string) => {
    // 若上一枚飞行头像尚未落地，先让它提前落地，避免玩家行一直隐藏。
    if (incomingRef.current && incomingRef.current !== targetId) {
      completeIncomingJoin(incomingRef.current);
    }
    const rowEl = document.querySelector<HTMLElement>(`[data-request-id="${targetId}"]`);
    const avatarEl = rowEl?.querySelector<HTMLElement>(".avatar");
    if (!avatarEl) return;
    const rect = avatarEl.getBoundingClientRect();
    const flight: JoinFlight = {
      id: targetId,
      name: targetName,
      ...(avatarData ? { avatarData } : {}),
      key: Date.now(),
      from: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      to: null,
      color: null,
    };
    joinFlightRef.current = flight;
    incomingRef.current = targetId;
    setJoinFlight(flight);
    setIncomingId(targetId);
    if (flightFallbackTimerRef.current) window.clearTimeout(flightFallbackTimerRef.current);
    flightFallbackTimerRef.current = undefined;
    // 兜底：万一服务器更新或目标行渲染异常，也不能让玩家行一直隐藏。
    flightFallbackTimerRef.current = window.setTimeout(() => {
      if (joinFlightRef.current?.id === targetId) completeIncomingJoin(targetId);
    }, 1600);
  }, [completeIncomingJoin]);

  // 飞行头像动画结束：落地，玩家行弹出。
  const handleFlightEnd = useCallback(() => {
    const flight = joinFlightRef.current;
    if (!flight || !flight.to) return;
    completeIncomingJoin(flight.id);
  }, [completeIncomingJoin]);

  const approveJoinRequest = async (targetId: string) => {
    // 先进入 loading，收到服务端确认后才由 room 事件启动退场与飞行动画（F003）。
    if (approvingRequestId) return;
    setApprovingRequestId(targetId);
    const ok = await sendCommand({ type: "approve-join", playerId: targetId });
    if (!ok) {
      setApprovingRequestId(null);
      setNotice("批准发送失败，请重试");
    }
  };

  const rejectJoinRequest = async (targetId: string, targetName: string, avatarData?: string) => {
    const ok = await sendCommand({ type: "reject-join", playerId: targetId });
    if (!ok) {
      setNotice("拒绝发送失败，请重试");
      return;
    }
    beginRequestExit(targetId, targetName, avatarData);
  };

  const askConfirm = (options: ConfirmDialog) => {
    setConfirmDialog(options);
  };

  const kickPlayer = (targetId: string, targetName: string) => {
    askConfirm({
      title: "踢出玩家",
      message: `确定要把 ${targetName} 踢出房间吗？`,
      confirmLabel: "踢出",
      tone: "danger",
      onConfirm: async () => {
        const ok = await sendCommand({ type: "kick", playerId: targetId });
        if (!ok) setNotice("踢出发送失败，请重试");
      },
    });
  };

  const goHome = async () => {
    stoppedRef.current = true;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    if (armedExpireRef.current) window.clearTimeout(armedExpireRef.current);
    // 主动离开：等待服务器 ACK 确认后再清会话（B023/F004）。
    if (sessionRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      await sendCommand({ type: "leave" });
    } else {
      try {
        wsRef.current?.close(1000, "bye");
      } catch {
        // Ignore closing errors.
      }
    }
    wsRef.current = null;
    socketSessionRef.current = null;
    sessionRef.current = null;
    roomRef.current = null;
    clearStoredSession();
    setRoom(null);
    updateSecretCard(null);
    setWsStatus("closed");
    setScreen("home");
    setCameraOpen(false);
    setJustJoinedId(null);
    setLeavingRequests([]);
    setJoinFlight(null);
    joinFlightRef.current = null;
    setIncomingId(null);
    incomingRef.current = null;
    if (flightFallbackTimerRef.current) window.clearTimeout(flightFallbackTimerRef.current);
    flightFallbackTimerRef.current = undefined;
    setCardRevealed(false);
    flipToggledRef.current = false;
    setKickMenuFor(null);
    setCopied(false);
    setJoinStatus("idle");
    setResuming(false);
    appliedRevisionRef.current = 0;
  };

  const handleLeaveClick = () => {
    // 两步确认：第一次点击进入待确认（高亮），再点一次才真正离开。
    if (!leaveArmed) {
      setLeaveArmed(true);
      setLeaveHint(true);
      // armed 状态 3 秒后自动过期（F013）。
      if (armedExpireRef.current) window.clearTimeout(armedExpireRef.current);
      armedExpireRef.current = window.setTimeout(() => {
        setLeaveArmed(false);
        setLeaveHint(false);
        armedExpireRef.current = undefined;
      }, 3000);
      return;
    }
    setLeaveArmed(false);
    setLeaveHint(false);
    void goHome();
  };

  const openScanner = () => {
    const nativeScanner = getPlatformBridge()?.scanCode;
    if (nativeScanner) {
      void nativeScanner()
        .then((value) => { if (value) handleScanSuccess(value); })
        .catch(() => setNotice("未完成扫码，请重试或手动输入邀请码"));
      return;
    }
    setCameraSwitchVisible(false);
    setCameraPhase("loading");
    setCameraMessage("正在打开摄像头…");
    setCameraClosing(false);
    setCameraOpen(true);
  };

  const switchCamera = () => {
    void (async () => {
      if (switchingRef.current) return;
      const ids = candidateDevicesRef.current.map((device) => device.deviceId);
      if (ids.length <= 1) return;
      switchingRef.current = true;
      const currentId = activeCameraDeviceIdRef.current;
      const currentIndex = currentId ? ids.indexOf(currentId) : -1;
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % ids.length : 0;
      try {
        setCameraMessage("正在切换摄像头…");
        // 先隐藏扫描框和按钮
        await enterCameraPhase("pre-closing", 100);
        // 再收合当前画面
        await enterCameraPhase("picture-closing", 260);
        // 等待新摄像头
        await enterCameraPhase("switching");
        const opened = await openFirstWorkingCandidate(nextIndex, "manual");
        if (!opened) {
          setCameraPhase("error");
          setCameraMessage("摄像头不可用，请选择图片或手动输入");
          return;
        }
        // 新横线向两边展开
        await enterCameraPhase("line-opening", 280);
        // 新画面向上下展开
        await enterCameraPhase("picture-opening", 460);
        await enterCameraPhase("ready");
        setCameraMessage("将二维码完整放入取景框");
      } finally {
        switchingRef.current = false;
      }
    })();
  };

  // 拍照或选择二维码图片兜底：系统相机 UI 负责镜头选择，支持时也可直接选图。
  const handleQrImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCameraMessage("正在识别图片…");
    try {
      // 用 createImageBitmap / object URL 解码，并把最长边下采样到 1600px，
      // 避免高分辨率照片产生多份大内存副本（B036）。
      let bitmap: ImageBitmap | HTMLImageElement;
      if ("createImageBitmap" in window) {
        bitmap = await createImageBitmap(file);
      } else {
        const objectUrl = URL.createObjectURL(file);
        try {
          const image = new Image();
          image.src = objectUrl;
          await image.decode();
          bitmap = image;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
      const maxEdge = 1600;
      const scale = Math.min(1, maxEdge / Math.max(1, Math.max(bitmap.width, bitmap.height)));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas-unavailable");
      ctx.drawImage(bitmap, 0, 0, width, height);
      if ("close" in bitmap) bitmap.close();
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const detector = createBarcodeDetector();
      const value = await decodeImageCanvas(canvas, imageData, detector);
      if (value) {
        // 与扫码成功走同一条验证 + 统一退出动画路径（F008/F010）。
        await closeScannerRef.current("image");
        await verifyJoinCodeRef.current(value);
      } else {
        setCameraMessage("图片中未识别到二维码");
      }
    } catch {
      setCameraMessage("图片读取失败，请换一张再试");
    }
  };

  const ensurePlatformProfile = async (): Promise<TiGameUserProfile | null> => {
    const bridge = getPlatformBridge();
    if (bridge?.kind !== "weapp") return platformProfile;
    const cached = bridge.getUserProfile?.() ?? platformProfile;
    if (cached?.nickname) {
      if (cached !== platformProfile) setPlatformProfile(cached);
      setForm({ name: cached.nickname });
      setJoinName(cached.nickname);
      return cached;
    }
    try {
      const profile = await bridge.ensureUserProfile?.();
      if (!profile?.nickname) throw new Error("未能获取微信昵称和头像");
      setPlatformProfile(profile);
      setForm({ name: profile.nickname });
      setJoinName(profile.nickname);
      return profile;
    } catch (error) {
      const detail = typeof (error as { errMsg?: unknown })?.errMsg === "string"
        ? (error as { errMsg: string }).errMsg
        : error instanceof Error ? error.message : "微信资料获取失败";
      setNotice(detail);
      return null;
    }
  };

  const createRoom = async () => {
    if (creatingRoom) return;
    const bridge = getPlatformBridge();
    const activeProfile = bridge?.kind === "weapp" ? await ensurePlatformProfile() : platformProfile;
    if (bridge?.kind === "weapp" && !activeProfile) return;
    const trimmedName = form.name.trim();
    const platformName = activeProfile?.nickname?.trim().slice(0, 12) || "";
    const playerName = platformName || trimmedName || "房主";
    if (!platformName && trimmedName) storeNickname(trimmedName);
    setCreatingRoom(true);
    try {
      // 房间号 409 碰撞时自动重试 2 次（B046）。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const roomId = makeRoomId();
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch("/api/rooms", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              roomId,
              hostName: playerName,
              ...(activeProfile?.avatarData ? { hostAvatarData: activeProfile.avatarData } : {}),
            }),
            signal: controller.signal,
          });
          if (response.status === 409 && attempt < 2) continue;
          if (!response.ok) throw new Error(await apiError(response, "创建房间失败"));
          const payload = (await response.json()) as { roomId: string; playerId: string; token: string; room: PublicRoom };
          const session: StoredSession = {
            roomId: payload.roomId,
            playerId: payload.playerId,
            token: payload.token,
            playerName,
          };
          sessionRef.current = session;
          storeSession(session);
          applySharedRoom(payload.room);
          setScreen("lobby");
          setNotice("房间已创建，把邀请码或二维码发给其他玩家");
          connectSocket(session);
          return;
        } finally {
          window.clearTimeout(timeout);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setNotice("创建房间超时，请重试");
      } else {
        setNotice(error instanceof Error ? error.message : "创建房间失败");
      }
    } finally {
      setCreatingRoom(false);
    }
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void createRoom();
  };

  const checkJoinRoom = async () => {
    if (checkingJoin) return;
    const roomId = normalizeRoomId(joinCode);
    if (!ROOM_ID_PATTERN.test(roomId)) {
      setNotice("请输入正确的房间邀请码");
      return;
    }
    setCheckingJoin(true);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { cache: "no-store" });
      if (!response.ok) {
        setNotice(await apiError(response, "房间不存在或已结束"));
        return;
      }
      setJoinCode(roomId);
      setJoinStep(1);
    } catch {
      setNotice("网络异常，请稍后再试");
    } finally {
      setCheckingJoin(false);
    }
  };

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void checkJoinRoom();
  };

  const requestToJoin = async () => {
    const roomId = normalizeRoomId(joinCode);
    const bridge = getPlatformBridge();
    const activeProfile = bridge?.kind === "weapp" ? await ensurePlatformProfile() : platformProfile;
    if (bridge?.kind === "weapp" && !activeProfile) return;
    const trimmedName = joinName.trim();
    const platformName = activeProfile?.nickname?.trim().slice(0, 12) || "";
    const playerName = platformName || trimmedName || "新玩家";
    if (!platformName && trimmedName) storeNickname(trimmedName);
    setJoinStatus("submitting");
    try {
      // 若本机已有同一房间的会话（例如掉线后凭证仍在但走了加入流程），
      // 把凭证一并提交，服务端可识别为“同一个人恢复”而不是新申请。
      const existingSession = readStoredSession();
      const resumeCredential = existingSession && existingSession.roomId === roomId
        ? { resumePlayerId: existingSession.playerId, resumeToken: existingSession.token }
        : null;
      const response = await fetch("/api/join-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId,
          playerName,
          ...(activeProfile?.avatarData ? { avatarData: activeProfile.avatarData } : {}),
          ...(resumeCredential ?? {}),
        }),
      });
      if (!response.ok) throw new Error(await apiError(response, "加入申请发送失败"));
      const payload = (await response.json()) as { playerId: string; token: string; resumed?: boolean };
      const session: StoredSession = { roomId, playerId: payload.playerId, token: payload.token, playerName };
      sessionRef.current = session;
      storeSession(session);
      if (payload.resumed) {
        // 已恢复原记录：直接重连，由服务器决定进入房间还是等待确认。
        setJoinStatus("idle");
        connectSocket(session);
        return;
      }
      setJoinStatus("waiting");
      setJoinStep(2);
      setNotice("申请已发送，等待房主确认");
      connectSocket(session);
    } catch (error) {
      setJoinStatus("error");
      setNotice(error instanceof Error ? error.message : "加入申请发送失败");
    }
  };

  const copyInvite = async () => {
    try {
      const ok = await copyTextToClipboard(inviteUrl);
      if (!ok) throw new Error("copy-failed");
      setCopied(true);
      setCopyFailed(false);
      setNotice("邀请链接已复制");
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = undefined;
        setCopied(false);
      }, 1800);
    } catch {
      setCopyFailed(true);
      setNotice("自动复制失败，请长按下方邀请链接手动复制");
    }
  };

  const beginFreshHomeFlow = async (nextScreen: "create" | "join") => {
    // 小程序直接在用户点击“创建/加入”这一手势里请求微信资料；
    // 微信自身负责授权弹窗，不再显示 TiGame 的独立身份入口页。
    if (getPlatformBridge()?.kind === "weapp" && !(await ensurePlatformProfile())) return;
    // 恢复旧房间失败时，resuming 可能会随着 WebSocket 重连持续很久。
    // 用户主动选择“创建/加入”应始终优先：终止旧恢复并清掉持久化 session，
    // 避免旧连接稍后恢复后又把新流程强制切回大厅/游戏。
    if (resuming || sessionRef.current || wsRef.current) terminateSession();
    if (nextScreen === "join") {
      setJoinStep(0);
      setJoinStatus("idle");
    }
    setScreen(nextScreen);
  };

  const renderHome = () => (
    <main className="site-shell home-shell" key={screen}>
      <section className="home-panel" aria-labelledby="site-title">
        <header className="topbar">
          <span className="room-badge"><img className="brand-logo" src="/favicon.png" alt="" /><span>聚会游戏助手</span></span>
        </header>
        <div className="home-grid">
          <div className="hero-copy">
            <h1 id="site-title">TiGame</h1>
            <div className="home-actions">
              <button className="button button-primary" onClick={() => void beginFreshHomeFlow("create")}>创建房间 <span>↗</span></button>
              <button className="button button-secondary" onClick={() => void beginFreshHomeFlow("join")}>加入房间</button>
            </div>
          </div>
          <div className="card-stage" aria-hidden="true">
            <div className="stage-glow" />
            <img className="card-stack-image" src="/logo.png" alt="" onError={() => setCardAssetFailed(true)} />
            {cardAssetFailed && <div className="logo-fallback"><span>TiGame</span></div>}
          </div>
        </div>
      </section>
      <p className="page-note">一局接一局</p>
    </main>
  );

  const renderCreate = () => (
    <main className="site-shell inner-shell" key={screen}>
      <div className="inner-topbar"><button className="back-button" onClick={() => void goHome()}>← <span>返回</span></button><span className="inner-label">创建房间</span></div>
      <section className="form-layout">
        <div className="form-intro"><span className="eyebrow">准备开局</span><h1>先把房间<br /><em>开起来</em></h1></div>
        <ActionForm className="glass-card form-card" onSubmit={handleCreate}>
          {getPlatformBridge()?.kind === "weapp" ? (
            <div className="miniapp-profile-lock"><span>微信昵称</span><strong>{platformProfile?.nickname || "微信用户"}</strong></div>
          ) : (<>
            <label className="field-label" htmlFor="host-name">你的昵称</label>
            <input id="host-name" className="text-input" value={form.name} onChange={(event) => setForm({ name: event.target.value })} maxLength={12} autoFocus />
          </>)}
          
          <ActionButton
            className="button button-primary form-submit"
            type="submit"
            onClick={getPlatformBridge()?.kind === "weapp" ? () => void createRoom() : undefined}
            disabled={creatingRoom}
          >{creatingRoom ? "正在创建…" : "创建房间"} {!creatingRoom && <span>↗</span>}</ActionButton>
        </ActionForm>
      </section>
    </main>
  );

  const renderJoin = () => (
    <main className="site-shell inner-shell join-shell" key={screen}>
      <div className="inner-topbar"><button className="back-button" onClick={() => void goHome()}>← <span>返回</span></button><span className="inner-label">加入房间</span></div>
      <section className="join-layout">
        <div className="join-copy"><span className="eyebrow">收到邀请</span><h1>加入<br /><em>房间</em></h1><p>输入邀请码或扫码，由房主确认后即可进入房间。</p><div className="join-steps"><span className={joinStep >= 0 ? "step active" : "step"}>01</span><i /><span className={joinStep >= 1 ? "step active" : "step"}>02</span><i /><span className={joinStep >= 2 ? "step active" : "step"}>03</span></div></div>
        <div className="glass-card join-card"><AnimatePresence mode="wait" initial={false}><m.div key={joinStep} className="join-step-motion" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18 }} transition={motionTokens.step}>
          {joinStep === 0 && <ActionForm onSubmit={handleJoin}>
            <label className="field-label" htmlFor="join-code">邀请码</label>
            <input id="join-code" className="text-input invite-input" value={joinCode} onChange={(event) => {
  const compact = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  setJoinCode(compact.length > 3 ? `${compact.slice(0, 3)}-${compact.slice(3)}` : compact);
}} placeholder="例如：K7P-4M2" maxLength={12} autoFocus />
            <div className="join-or"><span>或</span></div>
            <ActionButton className="scan-button" type="button" onClick={openScanner}><span className="scan-icon">⌗</span> 扫描房主二维码</ActionButton>
            <ActionButton
              className="button button-primary form-submit"
              type="submit"
              onClick={getPlatformBridge()?.kind === "weapp" ? () => void checkJoinRoom() : undefined}
              disabled={checkingJoin}
            >{checkingJoin ? "正在校验…" : "继续"} {!checkingJoin && <span>→</span>}</ActionButton>
          </ActionForm>}
          {joinStep === 1 && <div className="join-confirm">
            <span className="success-seal">✓</span><span className="eyebrow">已读取邀请</span><h2>{getPlatformBridge()?.kind === "weapp" ? "确认加入" : "输入你的昵称"}</h2><p>邀请来自房间 <strong>{joinCode || "—"}</strong></p>
            {getPlatformBridge()?.kind === "weapp" ? (
              <div className="miniapp-profile-lock"><span>微信昵称</span><strong>{platformProfile?.nickname || "微信用户"}</strong></div>
            ) : (<>
              <label className="field-label" htmlFor="join-name">昵称</label>
              <input id="join-name" className="text-input" value={joinName} onChange={(event) => setJoinName(event.target.value)} maxLength={12} autoFocus />
            </>)}
            <button className="button button-primary form-submit" type="button" onClick={requestToJoin} disabled={joinStatus === "submitting"}>{joinStatus === "submitting" ? "正在发送…" : "申请加入"} <span>→</span></button>
          </div>}
          {joinStep === 2 && <div className="join-confirm response-confirm">
            <span className="waiting-seal"><i /></span><span className="eyebrow">申请已发送</span>
            <h2>等待房主确认</h2>
            <p>房主确认后会自动进入房间。如果断线了，我们会自动重连。</p>
            <div className="waiting-status"><span /><strong>{wsStatus === "open" ? "正在等待确认" : "正在连接服务器"}</strong></div>
            {joinStatus === "error" && <button className="cancel-waiting" type="button" onClick={() => { setJoinStatus("idle"); setJoinStep(1); }}>返回重试</button>}
          </div>}
        </m.div></AnimatePresence>
        </div>
      </section>
    </main>
  );

  const renderPlayerRow = (player: Player, showConfirm: "none" | "vote" | "voted" | "next", allowKick: boolean, extra?: { role?: "undercover" | "blank"; eliminated?: boolean; record?: { wins: number; losses: number }; joinNextRound?: boolean; voteState?: { selected: boolean; confirmed: boolean }; ripple?: boolean }) => {
    const game = room?.game;
    const confirmed = showConfirm === "vote"
      ? game?.kind === "undercover" && game.voteReadyPlayerIds.includes(player.id)
      : showConfirm === "voted"
        ? game?.kind === "undercover" && game.votedPlayerIds.includes(player.id)
        : showConfirm === "next"
          ? game?.kind === "undercover" && game.nextRoundReadyPlayerIds.includes(player.id)
          : undefined;
    const confirmLabel = showConfirm === "voted"
      ? (confirmed ? "已投票" : player.online ? "待投票" : "离线待投票")
      : (confirmed ? "已确认" : player.online ? "待确认" : "离线待确认");
    const cancelLongPress = () => {
      if (kickMenuTimerRef.current) window.clearTimeout(kickMenuTimerRef.current);
      kickMenuTimerRef.current = undefined;
    };
    const voteState = extra?.voteState;
    return <m.div
      layout
      transition={motionTokens.layout}
      exit={{ opacity: 0, scale: 0.92, height: 0, marginBottom: 0 }}
      className={`player-row${extra?.role === "undercover" ? " player-role-undercover" : ""}${voteState ? " player-row-votable" : ""}${extra?.eliminated || extra?.joinNextRound ? " player-eliminated" : ""}${incomingId === player.id ? " player-incoming" : justJoinedId === player.id ? " just-joined" : ""} ${player.online ? "" : "player-offline"}`}
      key={player.id}
      data-player-id={player.id}
      data-votable={voteState ? "true" : undefined}
    >
      <span className={`avatar-wrap${showConfirm === "voted" || voteState?.selected || voteState?.confirmed ? " avatar-wrap-with-label" : ""}${voteState?.selected ? " avatar-wrap-selected" : ""}${voteState?.confirmed ? " avatar-wrap-confirmed" : ""}`}>
        <span
          className={`avatar avatar-${player.color}${voteState ? (voteState.confirmed ? " avatar-vote-confirmed" : voteState.selected ? " avatar-vote-selected" : "") : showConfirm === "voted" ? "" : confirmed ? " avatar-confirmed" : ""}${kickMenuFor === player.id ? " avatar-menu-open" : ""}`}
          onPointerDown={(event) => {
            if (!allowKick) return;
            event.preventDefault();
            // 用头像当前位置计算菜单落点（Portal 渲染在 body 下，坐标取视口坐标）
            const anchor = event.currentTarget;
            cancelLongPress();
            kickMenuTimerRef.current = window.setTimeout(() => {
              suppressAvatarClickRef.current = true;
              const rect = anchor.getBoundingClientRect();
              const menuWidth = 150;
              const menuHeight = 64;
              let x = rect.left;
              let y = rect.bottom + 8;
              if (x + menuWidth > window.innerWidth) x = Math.max(8, window.innerWidth - menuWidth);
              if (y + menuHeight > window.innerHeight) y = Math.max(8, rect.top - menuHeight - 8);
              setKickMenuPos({ x, y });
              setKickMenuFor(player.id);
            }, 500);
          }}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          aria-label={`${player.name}${allowKick ? "，长按头像可管理" : ""}`}
        >{avatarFace(player.name, player.avatarData)}{voteState && extra?.ripple && <span className="vote-avatar-ripples" aria-hidden="true"><i /><i /><i /></span>}</span>
        {(showConfirm === "voted" || voteState?.selected || voteState?.confirmed) && <span className={`vote-your-label${voteState?.confirmed ? "" : voteState?.selected ? " vote-your-label-pending" : " vote-your-label-hidden"}`}>{voteState?.confirmed ? "你的投票" : voteState?.selected ? "再次点击确认" : ""}</span>}
      </span>
      <div className="player-meta">
        <strong>{player.name}{player.id === room?.hostId && <span className="host-tag">房主</span>}{player.id === room?.localPlayerId && <span className="me-tag">我</span>}{extra?.role === "undercover" && <span className="role-tag role-tag-undercover">卧底</span>}{extra?.role === "blank" && <span className="role-tag role-tag-blank">白板</span>}{extra?.eliminated && <span className="out-tag">已淘汰</span>}{extra?.joinNextRound && <span className="out-tag">下一局加入</span>}</strong>
        <small className="player-status-line">
          {extra?.record ? <>赢{extra.record.wins} 输{extra.record.losses} · </> : null}
          <span className={player.online ? "status-online" : "status-offline"}>{player.online ? "在线" : "已断线"}</span>
        </small>
      </div>
      {showConfirm !== "none" && !extra?.joinNextRound && <span key={`${player.id}-${confirmed ? "confirmed" : "pending"}`} className={confirmed ? "ready-state ready confirm-state confirm-pop" : "confirm-state"}>{confirmLabel}</span>}
    </m.div>;
  };

  // 长按头像弹出的踢出菜单：Portal 到 body，避免被断线玩家的 opacity 层叠上下文盖住。
  const renderKickMenu = () => {
    if (!kickMenuFor) return null;
    const target = room?.players.find((player) => player.id === kickMenuFor);
    if (!target) return null;
    return createPortal(
      <>
        <button className="kick-menu-backdrop" type="button" aria-label="关闭菜单" onClick={() => setKickMenuFor(null)} />
        <div className="kick-menu" role="menu" style={kickMenuPos ? { left: kickMenuPos.x, top: kickMenuPos.y } : undefined}>
          <button className="kick-menu-item" type="button" role="menuitem" onClick={() => { setKickMenuFor(null); kickPlayer(target.id, target.name); }}>踢出 {target.name}</button>
        </div>
      </>,
      document.body,
    );
  };

  const pendingAndLeavingRequests = useMemo<{
    pending: PendingJoinRequest[];
    leaving: Array<{ id: string; playerName: string }>;
  }>(() => {
    const pending = room?.pendingJoinRequests ?? [];
    const pendingIds = new Set(pending.map((request) => request.id));
    return {
      pending,
      leaving: leavingRequests.filter((item) => !pendingIds.has(item.id)),
    };
  }, [room, leavingRequests]);

  const renderJoinRequestRow = (request: { id: string; playerName: string; avatarData?: string }, index: number, leaving: boolean) => (
    <div
      className={`join-request-row${leaving ? " leaving" : ""}`}
      key={request.id}
      data-request-id={request.id}
      style={leaving ? undefined : { animationDelay: `${index * 50}ms` }}
      onAnimationEnd={leaving ? (event) => {
        if (event.animationName === "request-leave") {
          setLeavingRequests((prev) => prev.filter((item) => item.id !== request.id));
        }
      } : undefined}
    >
      <span className="avatar avatar-sage">{avatarFace(request.playerName, request.avatarData)}</span>
      <strong>{request.playerName}</strong>
      <div className="join-request-actions">
        <button type="button" onClick={() => approveJoinRequest(request.id)} disabled={approvingRequestId === request.id}>{approvingRequestId === request.id ? "确认中…" : "确认"}</button>
        <button className="reject-button" type="button" onClick={() => rejectJoinRequest(request.id, request.playerName, request.avatarData)} disabled={approvingRequestId === request.id}>拒绝</button>
      </div>
    </div>
  );

  // 飞行头像：从申请列表位置飞到玩家列表，落地后触发新玩家行弹出。
  const renderJoinFlight = () => {
    if (!joinFlight) return null;
    const style = joinFlight.to
      ? {
          left: joinFlight.to.x,
          top: joinFlight.to.y,
          "--from-x": `${joinFlight.from.x - joinFlight.to.x}px`,
          "--from-y": `${joinFlight.from.y - joinFlight.to.y}px`,
          "--to-x": "0px",
          "--to-y": "0px",
        } as CSSProperties
      : { left: joinFlight.from.x, top: joinFlight.from.y, "--fx": "0px", "--fy": "0px" } as CSSProperties;
    return createPortal(
      <span
        key={joinFlight.key}
        className={`join-flight-avatar avatar-${joinFlight.color ?? "sage"}${joinFlight.to ? " flying" : " waiting"}`}
        style={style}
        onAnimationEnd={handleFlightEnd}
        aria-hidden="true"
      >{avatarFace(joinFlight.name, joinFlight.avatarData)}</span>,
      document.body,
    );
  };

  // 游戏界面内房主查看/处理加入申请。
  const renderPendingJoins = () => {
    if (!isHost || !room || (room.pendingJoinRequests.length === 0 && leavingRequests.length === 0)) return null;
    const { pending, leaving } = pendingAndLeavingRequests;
    return <div className="join-request-list game-join-requests">
      <span>加入申请</span>
      {pending.map((request, index) => renderJoinRequestRow(request, index, false))}
      {leaving.map((item, index) => renderJoinRequestRow(item, index + pending.length, true))}
    </div>;
  };

  const renderLobby = () => {
    if (!room) return null;
    const offlinePlayers = room.players.filter((player) => !player.online);
    const hostAway = Boolean(room.hostInLobby && isHost);
    return <main className="site-shell room-shell" key={screen}>
      <div className="room-topbar"><button className={`back-button armed-target${leaveArmed ? " button-armed" : ""}`} onClick={handleLeaveClick}>← <span>离开房间</span></button><div className="room-title"><span className="room-title-dot" />{room.roomId}</div><span className={`connection-pill ${wsStatus === "open" ? "connected" : "disconnected"}`} role="status" aria-live="polite"><i />{connectionLabel(wsStatus, reconnectPhase)}</span></div>
      {isHost && <div className={`leave-room-hint-wrap${leaveHintVisible && !leaveHintLeaving ? " leave-room-hint-open" : ""}`}>{leaveHintVisible && <p className="leave-room-hint">房主离开房间后，该房间将关闭</p>}</div>}
      <section className="room-heading"><div><span className="eyebrow">房主大厅</span><h1>房间</h1></div><div className="room-progress"><div className="progress-ring"><strong>{connectedCount}</strong><span>/ {ROOM_MAX_PLAYERS}</span></div><p>已加入</p></div></section>
      {hostAway && <p className="host-lobby-banner">你暂时离开了当前游戏，其他玩家仍在继续。新玩家加入后：麻将会立即上桌，另外两个游戏下一局自动加入。</p>}
      {renderKickMenu()}
      <div className="lobby-grid">
        <section className="glass-card player-card">
          <div className="card-header"><div><span className="section-kicker">玩家</span><h2>{room.players.length} / {ROOM_MAX_PLAYERS}</h2></div><span className="online-pill"><i />在线房间</span></div>
          <div className="player-list">
            <AnimatePresence initial={false} mode="popLayout">
              {room.players.map((player) => renderPlayerRow(player, "none", isHost && player.id !== room.localPlayerId))}
              {Array.from({ length: Math.max(0, Math.min(3, ROOM_MAX_PLAYERS - room.players.length)) }).map((_, index) => <div className="player-row empty-row" key={`empty-${index}`}><span className="avatar avatar-empty">+</span><div className="player-meta"><strong>等待玩家加入</strong><small>扫描页面中的二维码加入</small></div></div>)}
            </AnimatePresence>
          </div>
          {offlinePlayers.length > 0 && <p className="offline-note">有玩家断线：{playerNames(room.players, offlinePlayers.map((player) => player.id))}。房主可以将其踢出。</p>}
        </section>
        <aside className="lobby-side">
          <div className="glass-card invite-card">
            <div className="card-header"><div><span className="section-kicker">邀请玩家</span><h2>扫码加入</h2></div><span className="invite-symbol">⌗</span></div>
            <div className="lobby-qr-wrap">{getPlatformBridge()?.kind === "weapp" ? <MiniQrCode value={inviteUrl} className="lobby-qr-canvas" /> : <canvas ref={setQrCanvas} className="lobby-qr-canvas" aria-label="房间邀请二维码" />}</div><p className="lobby-room-code">{room.roomId}</p>
            <div className="invite-actions">{copyFailed ? <div className="manual-copy-block"><input className="manual-copy-input" readOnly value={inviteUrl} aria-label="房间邀请链接" onFocus={(event) => event.currentTarget.select()} onPointerUp={(event) => event.currentTarget.select()} /><p className="manual-copy-hint">自动复制失败：请长按或点选上方链接，复制后发给好友</p><button className="copy-link compact-link retry-copy" onClick={copyInvite}>重新自动复制</button></div> : <button className="copy-link compact-link" onClick={copyInvite}>{copied ? "✓ 已复制" : "复制邀请链接"}</button>}
              {(isHost && (room.pendingJoinRequests.length > 0 || leavingRequests.length > 0)) && <div className="join-request-list"><span>加入申请</span>{pendingAndLeavingRequests.pending.map((request, index) => renderJoinRequestRow(request, index, false))}{pendingAndLeavingRequests.leaving.map((item, index) => renderJoinRequestRow(item, index + pendingAndLeavingRequests.pending.length, true))}</div>}
            </div>
          </div>
        </aside>
      </div>
      <section className="glass-card game-picker">
        <div className="card-header"><div><span className="section-kicker">小游戏</span><h2>{hostAway ? "对局进行中" : "今天玩什么"}</h2></div>{!isHost ? <span className="game-picker-note">等待房主选择游戏</span> : hostAway ? <span className="game-picker-note">只能返回当前游戏</span> : null}</div>
        <div className="game-list">
          {GAME_LIST.map((game) => {
            const enoughPlayers = room.players.length >= game.minPlayers;
            const isCurrent = hostAway && game.id === room.gameId;
            return <div key={game.id} className={`game-card${!isHost || (hostAway && !isCurrent) ? " game-card-locked" : ""}`}>
              <span className="game-card-symbol" aria-hidden="true">{game.symbol}</span>
              <div className="game-card-meta">
                <strong>{game.name}</strong>
                <span className="game-card-tagline">{game.tagline} · 至少 {game.minPlayers} 人</span>
                <small>{game.description}</small>
              </div>
              <div className="game-card-action">
                {isHost
                  ? hostAway
                    ? isCurrent
                      ? <button className="button button-primary game-card-enter" onClick={returnToGame}>返回游戏</button>
                      : <span className="game-card-waiting">对局中不可切换</span>
                    : <button className="button button-primary game-card-enter" onClick={() => enterGame(game.id)} disabled={!enoughPlayers}>{enoughPlayers ? "进入游戏" : `还差 ${game.minPlayers - room.players.length} 人`}</button>
                  : <span className="game-card-waiting">等待房主选择</span>}
              </div>
            </div>;
          })}
        </div>
        {hostAway && <div className="lobby-actions">
          <button className={`button button-secondary large-button button-danger armed-target${endGameArmed ? " button-armed" : ""}`} onClick={endGameFromLobby}>结束游戏</button>
        </div>}
      </section>
    </main>;
  };

  const renderGameTopbar = (centerLabel: string) => (
    <div className="game-topbar">
      <div className="game-topbar-left">{isHost ? <button className="back-button" onClick={backToLobby}>← <span>返回大厅</span></button> : <button className={`back-button armed-target${leaveArmed ? " button-armed" : ""}`} onClick={handleLeaveClick}>← <span>离开房间</span></button>}</div>
      <span className="round-label" key={centerLabel}>{centerLabel}</span>
      <div className="game-topbar-right"><span className="room-title">{room?.roomId}</span>{!isHost && room?.hostInLobby && <span className="host-away-pill"><i />房主在大厅</span>}<span className={`connection-pill ${wsStatus === "open" ? "connected" : "disconnected"}`} role="status" aria-live="polite"><i />{connectionLabel(wsStatus, reconnectPhase)}</span></div>
    </div>
  );

  const renderUndercoverSettings = (mode: "setup" | "next") => {
    const game = room?.game;
    if (!game || game.kind !== "undercover") return null;
    const maxUndercover = Math.max(1, Math.min(3, Math.ceil(room.players.length / 2) - 1));
    const undercoverValue = Math.min(game.settings.undercover, maxUndercover);
    // 兼容旧房间数据：词库范围升级为多选后，缺失 scopes 时回退为“轻松”。
    const selectedScopes: WordBankScope[] = Array.isArray(game.settings.scopes) && game.settings.scopes.length > 0
      ? game.settings.scopes
      : [1];
    return <section className="glass-card settings-card next-round-settings">
      <div className="card-header"><div><span className="section-kicker">游戏设置</span><h2>{mode === "setup" ? "本局设置" : "下一局生效"}</h2></div><span className="settings-symbol">✦</span></div>
      <div className="setting-list room-settings-list">
        <div className={`room-setting roller-setting${isHost ? "" : " roller-disabled"}`}>
          <span>卧底人数</span>
          <UndercoverRoller
  value={undercoverValue}
  max={maxUndercover}
  ariaLabel="卧底人数"
  disabled={!isHost}
  onChange={(value) =>
    updateUndercoverSettings({
      undercover: value,
    })
  }
/>
        </div>
        <div className="room-setting setting-switch"><span className="setting-switch-label">白板<small>卧底 10% 概率是白板</small></span><button type="button" role="switch" aria-checked={game.settings.blank > 0} className={`toggle${game.settings.blank > 0 ? " toggle-on" : ""}`} disabled={!isHost} onClick={() => updateUndercoverSettings({ blank: game.settings.blank > 0 ? 0 : 1 })}><span className="toggle-knob" aria-hidden="true" /></button></div>
        <div className={`room-setting scope-setting${isHost ? "" : " scope-setting-disabled"}`}>
          <span>词库范围<small>可多选，发牌时随机使用所选范围</small></span>
          <div className="scope-options" role="group" aria-label="词库范围">
            {([1, 2, 3] as const).map((scope) => {
              const scopeSelected = selectedScopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  className={`scope-option${scopeSelected ? " scope-option-active" : ""}`}
                  aria-pressed={scopeSelected}
                  disabled={!isHost}
                  onClick={() => {
                    const nextScopes = scopeSelected
                      ? selectedScopes.filter((item) => item !== scope)
                      : [...selectedScopes, scope];
                    // 至少保留一个词库范围，避免无词可用。
                    if (nextScopes.length > 0) updateUndercoverSettings({ scopes: nextScopes });
                  }}
                >
                  {scope === 1 ? "轻松" : scope === 2 ? "标准" : "烧脑"}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>;
  };

  const renderUndercoverGame = (game: UndercoverPublicState) => {
    if (!room) return null;
    // 本局实际参与的玩家人数（“下一局才加入”的新人、已淘汰的观战者不计入）。
    const eliminatedIds = new Set(game.eliminatedPlayerIds);
    const localEliminated = eliminatedIds.has(room.localPlayerId);
    const activePlayerCount = room.players.filter((player) => !player.joinNextRound && !eliminatedIds.has(player.id)).length;
    // 准备下一局时，所有玩家（含本局已淘汰者和下一局加入的新人）都要参与确认。
    const participantCount = room.players.length;
    const voteReadyCount = game.voteReadyPlayerIds.length;
    const votedCount = game.votedPlayerIds.length;
    const nextRoundReadyCount = game.nextRoundReadyPlayerIds.length;
    const hasVoteReady = Boolean(currentPlayer && game.voteReadyPlayerIds.includes(currentPlayer.id));
    const hasVoted = Boolean(currentPlayer && game.votedPlayerIds.includes(currentPlayer.id));
    const hasPreparedNextRound = Boolean(currentPlayer && game.nextRoundReadyPlayerIds.includes(currentPlayer.id));
    const gameOver = game.winner !== null;
    // 投票结果页是否仍在本机展示（未结算时由本地“继续”按钮关闭，不强制所有人同步）。
    const showVoteResult = Boolean(pendingVoteResult || (game.phase === "REVEALED" && !gameOver && Boolean(game.voteResult)));
    const voteResult = game.voteResult;
    const reveal = voteResult?.reveal ?? null;
    const viewerIsUndercover = Boolean(reveal?.undercoverPlayers.some((player) => player.playerId === room.localPlayerId));
    const viewerWins = game.winner === "undercover" ? viewerIsUndercover : !viewerIsUndercover;
    const undercoverIdSet = new Set((reveal?.undercoverPlayers ?? []).map((player) => player.playerId));
    const blankIdSet = new Set((reveal?.blankPlayers ?? []).map((player) => player.playerId));
    // 游戏结束时把本局全部身份放进玩家列表（被淘汰的卧底/白板也保留展示）
    const displayPlayers = room.players.map((player) => ({
      ...player,
      role: gameOver && reveal
        ? (blankIdSet.has(player.id) ? ("blank" as const) : undercoverIdSet.has(player.id) ? ("undercover" as const) : undefined)
        : undefined,
      eliminated: eliminatedIds.has(player.id),
    }));
    const minPlayers = GAME_LIST.find((item) => item.id === "undercover")?.minPlayers ?? 3;
    const isLastVoter = votedCount === activePlayerCount - 1;
    // 离线操作提示：只有所有在线玩家都已操作、仅剩离线玩家未完成时才显示。
    const offlineUnconfirmed = game.phase === "PLAYING"
      ? room.players.filter((player) => !player.joinNextRound && !eliminatedIds.has(player.id) && player.online).every((player) => game.voteReadyPlayerIds.includes(player.id))
        ? room.players.filter((player) => !player.online && !player.joinNextRound && !game.voteReadyPlayerIds.includes(player.id) && !eliminatedIds.has(player.id))
        : []
      : game.phase === "VOTING"
        ? room.players.filter((player) => !player.joinNextRound && !eliminatedIds.has(player.id) && player.online).every((player) => game.votedPlayerIds.includes(player.id))
          ? room.players.filter((player) => !player.online && !player.joinNextRound && !game.votedPlayerIds.includes(player.id) && !eliminatedIds.has(player.id))
          : []
        : game.phase === "REVEALED"
          ? room.players.filter((player) => player.online).every((player) => game.nextRoundReadyPlayerIds.includes(player.id))
            ? room.players.filter((player) => !player.online && !game.nextRoundReadyPlayerIds.includes(player.id))
            : []
          : [];
    const heading = game.phase === "SETUP"
      ? { eyebrow: "准备游戏", title: isHost ? <><span>设置</span><br /><em>本局规则</em></> : <><span>等待</span><br /><em>房主设置</em></>, note: isHost ? "调整卧底人数与词库后，点击下方「开始游戏」发牌。" : "房主正在设置本局规则，完成后会自动发牌。" }
      : showVoteResult && !gameOver
        ? { eyebrow: "投票结果", title: <><span>投票</span><br /><em>结果</em></>, note: currentPlayer?.joinNextRound ? "本局结果仅可查看，你将在下一局加入。" : "查看投票结果后，点击「继续」回到对局。" }
        : game.phase === "PLAYING"
      ? { eyebrow: "你的牌", title: currentPlayer?.joinNextRound ? <><span>下一局</span><br /><em>加入</em></> : <><span>你的牌</span><br /><em>在这里</em></>, note: localEliminated ? "你已出局，请静观本局结束。" : currentPlayer?.joinNextRound ? "你将在下一局自动加入，本局无需操作。" : "讨论发言后，点击「准备投票」。" }
      : game.phase === "VOTING"
        ? { eyebrow: "投票环节", title: <><span>选出</span><br /><em>卧底</em></>, note: "投票结果将在所有玩家提交后公布。" }
        : { eyebrow: "投票结果", title: <><span>投票</span><br /><em>结果</em></>, note: gameOver ? "所有玩家确认后，将开始下一局。" : "查看投票结果后，点击「继续」回到对局。" };
    return <main className="site-shell game-shell" key={screen}>
      {renderGameTopbar(game.phase === "SETUP" ? "游戏设置" : `第 ${game.round} 局`)}
      <section className={`game-heading${game.phase === "REVEALED" ? " game-heading-reveal" : ""}`} key={`${game.phase}-${game.round}`}><span className="eyebrow">{heading.eyebrow}</span><h1>{heading.title}</h1><p>{heading.note}</p></section>
      {game.phase === "SETUP" && renderUndercoverSettings("setup")}
      {game.phase === "PLAYING" && !showVoteResult && !localEliminated && !currentPlayer?.joinNextRound && <div className={`secret-card-wrap${cardRevealed ? " revealed" : ""}`} key={game.round}>
        <span className="card-halo" aria-hidden="true" />
        <button className={`secret-card${cardRevealed ? " revealed" : ""} ${flipRight ? "flip-right" : "flip-left"} ${game.round % 2 === 0 ? "tilt-right" : "tilt-left"}`} onPointerDown={startUndercoverFlip} onPointerUp={closeUndercoverCard} onPointerLeave={closeUndercoverCard} onPointerCancel={closeUndercoverCard} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); startUndercoverFlip(); } }} onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") closeUndercoverCard(); }} aria-label="按住查看自己的牌">
          <span className="secret-card-inner">
            <span className="secret-card-face secret-card-front">
              <span className="secret-card-corner">{game.round}</span>
              {secretCard
                ? <>
                    <span className="hidden-symbol">?</span>
                    <strong>按住查看自己的牌</strong>
                  </>
                : <>
                    <span className="word-reveal">正在发牌</span>
                    <small>请稍候</small>
                  </>}
              <span className="card-shine" aria-hidden="true" />
            </span>
            <span className="secret-card-face secret-card-back">
              <span className="secret-card-corner">{game.round}</span>
              {cardRevealed && secretCard
                ? <>
                    <span className="word-reveal">{secretCard.isBlank ? "你是白板" : secretCard.word}</span>
                    <small>{secretCard.isBlank ? `类别提示：${secretCard.category}` : "请不要让别人看到"}</small>
                    <span className="card-sparkles" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
                  </>
                : <>
                    <span className="hidden-symbol">?</span>
                    <strong>按住查看自己的牌</strong>
                  </>}
              <span className="card-shine" aria-hidden="true" />
            </span>
          </span>
        </button>
      </div>}

      {showVoteResult && !gameOver && <section className="round-result" key={`pending-${pendingVoteResult?.key ?? game.round}`} aria-live="polite">
        <span className="result-burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
        <span className="section-kicker">投票结果</span>
        {localEliminated && <span className="eliminated-you">你被淘汰</span>}
        <div className="result-grid vote-grid">
          {(pendingVoteResult?.counts ?? game.voteResult?.voteCounts ?? []).map((entry) => {
            const candidate = room.players.find((player) => player.id === entry.playerId);
            const eliminatedId = pendingVoteResult?.eliminatedPlayerId ?? game.voteResult?.eliminatedPlayerId;
            return (
              <div key={entry.playerId} className={`vote-tally${entry.playerId === eliminatedId ? " vote-tally-eliminated" : ""}`}>
                {entry.playerId === eliminatedId && <span className="vote-tally-stamp">已淘汰</span>}
                <div className="vote-tally-person">{candidate && <span className={`avatar avatar-${candidate.color} vote-tally-person-avatar`}>{avatarFace(candidate.name, candidate.avatarData)}</span>}<small>{entry.playerName}</small></div>
                <strong>{entry.count} 票</strong>
                <div className="vote-tally-voters">{(entry.voterIds ?? []).map((voterId) => { const voter = room.players.find((player) => player.id === voterId); return voter ? <span key={voterId} className={`avatar avatar-${voter.color} vote-tally-avatar`}>{avatarFace(voter.name, voter.avatarData)}</span> : null; })}</div>
              </div>
            );
          })}
        </div>
        <p className="result-line"><span>出局</span>{(pendingVoteResult?.tie ?? game.voteResult?.tie) ? "平票·无人出局" : (pendingVoteResult?.eliminatedName ?? game.voteResult?.eliminatedPlayerName) || "无人"}</p>
      </section>}
      {game.phase === "REVEALED" && gameOver && <section className="round-result" key={game.round} aria-live="polite">
        <span className="result-burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
        {voteResult ? <>
          <span className="section-kicker">投票结果</span>
          <div className="result-grid vote-grid">
            {voteResult.voteCounts.map((entry) => {
              const candidate = room.players.find((player) => player.id === entry.playerId);
              return (
                <div key={entry.playerId} className={`vote-tally${entry.playerId === voteResult.eliminatedPlayerId ? " vote-tally-eliminated" : ""}`}>
                  {entry.playerId === voteResult.eliminatedPlayerId && <span className="vote-tally-stamp">已淘汰</span>}
                  <div className="vote-tally-person">{candidate && <span className={`avatar avatar-${candidate.color} vote-tally-person-avatar`}>{avatarFace(candidate.name, candidate.avatarData)}</span>}<small>{entry.playerName}</small></div>
                  <strong>{entry.count} 票</strong>
                  <div className="vote-tally-voters">{(entry.voterIds ?? []).map((voterId) => { const voter = room.players.find((player) => player.id === voterId); return voter ? <span key={voterId} className={`avatar avatar-${voter.color} vote-tally-avatar`}>{avatarFace(voter.name, voter.avatarData)}</span> : null; })}</div>
                </div>
              );
            })}
          </div>
          <p className="result-line"><span>出局</span>{voteResult.eliminatedPlayerName || "无人"}{voteResult.tie ? "（平票随机）" : ""}</p>
          {gameOver && reveal && <>
            <div className={`victory-banner ${viewerWins ? "victory-win" : "victory-loss"}`}><span>{game.winner === "undercover" ? "卧底胜利" : "平民胜利"}</span><small>{game.winner === "undercover" ? "卧底坚持到了最后" : "卧底已被找出"}</small></div>
            <div className="result-grid">
              <div className={`result-word${!viewerIsUndercover ? " result-word-mine" : ""}`}><small>平民词</small><strong>{reveal.normalWord}</strong></div>
              <div className={`result-word result-word-undercover${viewerIsUndercover ? " result-word-mine" : ""}`}><small>卧底词</small><strong>{reveal.undercoverWord}</strong></div>
            </div>
          </>}
        </> : <p className="result-syncing">正在统计投票…</p>}
      </section>}
      {game.phase === "PLAYING" && !showVoteResult && <div className="vote-ready-wrap vote-ready-above-card">
        {localEliminated
          ? <p className="voting-note vote-out-note">你已出局，等待本局结束。</p>
          : currentPlayer?.joinNextRound
            ? <p className="voting-note">你将在下一局加入，本局无需操作。</p>
            : <>
              <button key={`vote-${hasVoteReady}`} className={hasVoteReady ? "button button-primary button-pop button-ready" : "button button-primary large-button"} onClick={toggleVoteReady}>{hasVoteReady ? "已准备投票" : "准备投票"} <span>→</span></button>
              <ProgressBar count={voteReadyCount} total={activePlayerCount} />
              {game.voteResult?.tie && game.voteResult.round === game.round && <p className="voting-note vote-tie-note">本轮平票，无人出局，请重新投票。</p>}
            </>}
      </div>}
      {showVoteResult && !gameOver && !localEliminated && <div className="vote-ready-wrap vote-ready-above-card">
        {currentPlayer?.joinNextRound
          ? <p className="voting-note">你将在下一局加入，本局结果仅可查看。</p>
          : <button key="continue-round" className="button button-primary large-button" onClick={continueUndercoverRound}>继续 <span>→</span></button>}
      </div>}
      {game.phase === "REVEALED" && gameOver && <div className="vote-ready-wrap vote-ready-above-card">
        <button key={`next-${hasPreparedNextRound}`} className={hasPreparedNextRound ? "button button-primary button-pop button-ready" : "button button-primary large-button"} onClick={toggleNextRoundReady}>{hasPreparedNextRound ? "已准备下一局" : "准备下一局"} <span>→</span></button>
        <ProgressBar count={nextRoundReadyCount} total={participantCount} />
        {game.nextRoundBlocked && <p className="voting-note vote-blocked-hint">人数不足，至少需要 3 人才能进入下一局，请等待新玩家加入。</p>}
      </div>}
      <section className="glass-card players-card">
        <div className="card-header"><div><span className="section-kicker">房间玩家</span><h2>{displayPlayers.length} 人</h2></div><span className="online-pill"><i />{connectedCount} 在线</span></div>
        <div className="player-list" onClick={handlePlayerListClick}>
          <AnimatePresence initial={false} mode="popLayout">
          {displayPlayers.map((player) => {
            const joinNext = game.phase === "SETUP" ? false : Boolean(player.joinNextRound);
            const isOut = Boolean(player.eliminated);
            const showConfirm = joinNext ? "none" : (game.phase === "PLAYING" ? "vote" : game.phase === "VOTING" ? "voted" : game.phase === "REVEALED" ? "next" : "none");
            const voteState = game.phase === "VOTING" && !localEliminated && !joinNext && !isOut && player.id !== room.localPlayerId && !currentPlayer?.joinNextRound
              ? { selected: voteTarget === player.id, confirmed: confirmedVote === player.id }
              : undefined;
            return renderPlayerRow(player, showConfirm, isHost && player.id !== room.localPlayerId, {
              role: player.role,
              eliminated: isOut,
              joinNextRound: joinNext,
              record: game.records[player.id],
              voteState,
              // 投票阶段引导点击：未选中任何目标时，可投票头像持续发出涟漪。
              ripple: Boolean(voteState && !voteTarget),
            });
          })}
          </AnimatePresence>
        </div>
        {renderPendingJoins()}
        {offlineUnconfirmed.length > 0 && <p className="offline-note">还差离线玩家的操作：{playerNames(room.players, offlineUnconfirmed.map((player) => player.id))}。房主可将其踢出后继续。</p>}
      </section>
      <div className="game-bottom">
        {game.phase === "SETUP" && <div className="vote-ready-wrap">
          {isHost
            ? <button key="start-undercover" className="button button-primary large-button" onClick={startUndercoverGame} disabled={room.players.length < minPlayers}>{room.players.length < minPlayers ? `还差 ${minPlayers - room.players.length} 人` : "开始游戏"} <span>→</span></button>
            : <p className="voting-note">等待房主设置本局规则并开始游戏。</p>}
        </div>}
        {game.phase === "VOTING" && <div className="vote-ready-wrap">
          {localEliminated
            ? <p className="voting-note vote-out-note">你已出局，等待投票结束。</p>
            : currentPlayer?.joinNextRound
              ? <p className="voting-note">你将在下一局加入，本局不参与投票。</p>
              : <>
                {isLastVoter && !hasVoted && <p className="voting-note vote-last-hint">其余玩家都已选择，你选择之后将自动揭晓谜底。</p>}
                <p className="voting-note">{voteTarget && voteTarget !== confirmedVote ? "再次点击已选中的玩家确认投票" : confirmedVote ? "已投票，可点击其他玩家修改" : hasVoted ? "你已投票，可点击玩家修改" : "点击玩家行选择要投出的玩家"}</p>
              </>}
          {votedCount > 0 && <div className="vote-ready-bar"><div className="vote-ready-track"><div className="vote-ready-fill" style={{ width: `${activePlayerCount ? (votedCount / activePlayerCount) * 100 : 0}%` }} /></div><span className="vote-ready-count">{votedCount}/{activePlayerCount}</span></div>}
        </div>}
      </div>
      {isHost && game.phase !== "SETUP" && renderUndercoverSettings("next")}
      {renderKickMenu()}
    </main>;
  };

  const renderChallengeSettings = (mode: "setup" | "next") => {
    const game = room?.game;
    if (!game || game.kind !== "challenge") return null;
    return <section className="glass-card settings-card next-round-settings">
      <div className="card-header"><div><span className="section-kicker">游戏设置</span><h2>{mode === "setup" ? "本局设置" : "下一局生效"}</h2></div><span className="settings-symbol">✦</span></div>
      <div className="setting-list room-settings-list">
        <div className={`room-setting roller-setting${isHost ? "" : " roller-disabled"}`}>
          <span>每人生命</span>
          <div className="roller-with-unit">
            <UndercoverRoller
  value={game.settings.lives}
  max={null}
  ariaLabel="挑战模式生命数"
  disabled={!isHost}
  onChange={(value) =>
    updateChallengeSettings({
      lives: value,
    })
  }
/>
            <span className="roller-unit">条</span>
          </div>
        </div>
      </div>
    </section>;
  };

  const renderChallengeGame = (game: ChallengePublicState) => {
    if (!room) return null;
    const eliminated = new Set(game.eliminatedPlayerIds);
    const winner = game.winnerId ? room.players.find((player) => player.id === game.winnerId) ?? null : null;
    const activePlayers = room.players.filter((player) => !eliminated.has(player.id) && !player.joinNextRound);
    const minPlayers = GAME_LIST.find((item) => item.id === "challenge")?.minPlayers ?? 2;
    return <main className="site-shell game-shell" key={screen}>
      {renderGameTopbar(game.phase === "SETUP" ? "游戏设置" : "不要做挑战")}
      {game.phase === "SETUP" && <section className="game-heading" key="challenge-setup"><span className="eyebrow">准备游戏</span><h1>{isHost ? <><span>设置</span><br /><em>本局规则</em></> : <><span>等待</span><br /><em>房主设置</em></>}</h1><p>{isHost ? "调整生命数后，点击下方「开始游戏」发牌。" : "房主正在设置本局规则，完成后会自动发牌。"}</p></section>}
      {game.phase !== "SETUP" && <section className="game-heading" key={`challenge-${game.phase}`}><span className="eyebrow">不要做挑战</span><h1><span>忍住</span><br /><em>别犯规</em></h1><p>{game.phase === "ENDED" ? `${winner?.name ?? "玩家"} 坚持到了最后！` : ""}</p></section>}
      {game.phase === "SETUP" && renderChallengeSettings("setup")}

      {game.phase === "ENDED" && <section className="round-result" key="challenge-ended">
        <span className="result-burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
        <span className="section-kicker">挑战结束</span>
        <div className="victory-banner"><span>{winner?.name ?? "无人"} 获胜</span><small>最后一位没犯规的玩家</small></div>
        <div className="game-bottom">{isHost
          ? <button className="button button-primary large-button button-pop" onClick={restartChallenge}>再来一局 <span>↻</span></button>
          : <p className="voting-note">等待房主开始下一局。</p>}</div>
      </section>}
      <section className="glass-card players-card">
        <div className="card-header"><div><span className="section-kicker">场上玩家</span><h2>{activePlayers.length} / {room.players.length} 存活</h2></div><span className="online-pill"><i />{connectedCount} 在线</span></div>
        <div className="player-list">
          <AnimatePresence initial={false} mode="popLayout">
          {room.players.map((player) => {
            const joinNext = game.phase === "SETUP" ? false : Boolean(player.joinNextRound);
            const isOut = !joinNext && eliminated.has(player.id);
            const isSelf = player.id === room.localPlayerId;
            const lives = joinNext ? 0 : (game.lives[player.id] ?? 0);
            const record = game.records[player.id];
            const action = joinNext ? null : (game.visibleCards[player.id] ?? null);
            const anim = cardAnim && cardAnim.playerId === player.id ? cardAnim : null;
            const animKey = anim ? `${action ?? ""}-${anim.nonce}` : action;
            // 视觉上最多展示 4 张牌，多出的只计数不叠加。
            const stackCount = !isOut && !joinNext ? Math.min(Math.max(lives, 1), 4) : 0;
            return <m.div layout exit={{ opacity: 0, scale: 0.92, height: 0, marginBottom: 0 }} transition={motionTokens.layout} data-player-id={player.id} className={`player-row challenge-player-row${isOut || joinNext ? " player-eliminated" : ""}${incomingId === player.id ? " player-incoming" : justJoinedId === player.id ? " just-joined" : ""} ${player.online ? "" : "player-offline"}`} key={player.id}>
              <span className={`avatar avatar-${player.color}`}>{avatarFace(player.name, player.avatarData)}</span>
              <div className="player-meta">
                <strong>{player.name}{player.id === room?.hostId && <span className="host-tag">房主</span>}{player.id === room?.localPlayerId && <span className="me-tag">我</span>}{isOut && <span className="out-tag">淘汰</span>}{joinNext && <span className="out-tag">下一局加入</span>}</strong>
                <small className="player-status-line">
                  {record ? <>赢{record.wins} 输{record.losses} · </> : null}
                  <span className={player.online ? "status-online" : "status-offline"}>{player.online ? "在线" : "已断线"}</span>
                </small>
                {!joinNext && lives > 0 && <small className="lives-display">{lives > 20 ? `❤×${lives}` : "❤".repeat(lives)}</small>}
              </div>
              {game.phase !== "SETUP" && <div className="challenge-row-main">
                {isOut
                  ? <div className="challenge-row-card challenge-card-out-card"><strong className="challenge-out-stamp">已淘汰</strong></div>
                  : joinNext
                    ? <div className="challenge-row-card challenge-card-join-card">下一局加入</div>
                    : <div className="challenge-card-stack">
                        {Array.from({ length: stackCount }).map((_, index) => {
                          const isTop = index === stackCount - 1;
                          // 顶层摆正便于阅读；旋转放在外层，翻牌/惩罚动画放在内层，互不冲突。
                          const stackStyle = { "--stack-rot": isTop ? 0 : (index - (stackCount - 1) / 2) * 3 } as CSSProperties;
                          if (!isTop) return <div key={`layer-${index}`} className="challenge-stack-layer" style={stackStyle} />;
                          return isSelf
                            ? <div key={`top-${animKey}`} style={stackStyle} className="challenge-stack-layer">
                                <div className={`challenge-stack-face challenge-card-back${anim ? ` challenge-card-anim-${anim.kind}` : ""}`} onAnimationEnd={(event) => { if (anim && anim.kind !== "swap" && event.target === event.currentTarget) setCardAnim(null); }}><span className="challenge-card-back-mark">?</span><strong>你的牌</strong><small>只有别人能看到</small>{anim?.kind === "swap" && <><span className="challenge-swap-dim" aria-hidden="true" /><span className="challenge-swap-label" aria-hidden="true" onAnimationEnd={(event) => { event.stopPropagation(); setCardAnim(null); }}>换牌</span></>}</div>
                              </div>
                            : <div key={`top-${animKey}`} style={stackStyle} className="challenge-stack-layer">
                                <div className={`challenge-stack-face challenge-card-front${anim ? ` challenge-card-anim-${anim.kind}` : ""}`} onAnimationEnd={(event) => { if (anim && event.target === event.currentTarget) setCardAnim(null); }}><span className="challenge-card-action">{action ?? "…"}</span></div>
                              </div>;
                        })}
                      </div>}
                {isHost && !joinNext && !isOut && game.phase === "PLAYING" && <div className="challenge-row-actions">
                  <button className="kick-button penalize-button" type="button" onClick={() => askConfirm({ title: "惩罚", message: `确定 ${player.id === room.localPlayerId ? "你" : player.name} 犯规了，要惩罚一次吗？（弃一张牌、少一条命）`, confirmLabel: "惩罚", tone: "danger", onConfirm: () => penalizeChallenge(player.id) })}>惩罚</button>
                  <button className="kick-button swap-button" type="button" onClick={() => askConfirm({ title: "换牌", message: `确定让 ${player.id === room.localPlayerId ? "你" : player.name} 换一张当前牌？（总牌数不变）`, confirmLabel: "换牌", onConfirm: () => swapChallenge(player.id) })}>换牌</button>
                  <button className="kick-button reward-button" type="button" onClick={() => askConfirm({ title: "奖励", message: `确认 ${player.id === room.localPlayerId ? "你" : player.name} 猜中了当前禁忌牌？将丢弃当前牌、抽两张新牌加入牌堆并展示一张，加一条命`, confirmLabel: "奖励", onConfirm: () => rewardChallenge(player.id) })}>奖励</button>
                </div>}
              </div>}
            </m.div>;
          })}
          </AnimatePresence>
        </div>
        {renderPendingJoins()}
      </section>
      {game.phase === "SETUP" && <div className="game-bottom">
        {isHost
          ? <button key="start-challenge" className="button button-primary large-button" onClick={startChallengeGame} disabled={room.players.length < minPlayers}>{room.players.length < minPlayers ? `还差 ${minPlayers - room.players.length} 人` : "开始游戏"} <span>→</span></button>
          : <p className="voting-note">等待房主设置本局规则并开始游戏。</p>}
      </div>}
      {isHost && game.phase !== "SETUP" && renderChallengeSettings("next")}
      {renderKickMenu()}
      {challengeReveal && <ChallengeLostCardReveal key={challengeReveal.key} action={challengeReveal.action} onDismiss={dismissLostCardReveal} />}
    </main>;
  };

  const renderMahjongGame = (game: MahjongPublicState) => {
    if (!room) return null;
    const allPlayerCount = room.players.length;
    const resetReadyCount = game.resetReadyPlayerIds.length;
    const settleReadyCount = game.settleReadyPlayerIds.length;
    const hasResetReady = Boolean(currentPlayer && game.resetReadyPlayerIds.includes(currentPlayer.id));
    const hasSettleReady = Boolean(currentPlayer && game.settleReadyPlayerIds.includes(currentPlayer.id));
    const targetPlayer = mahjongTarget ? room.players.find((player) => player.id === mahjongTarget) : null;
    // 已离桌但带分的玩家仍计入账本，因此结账按钮的判断要包含他们（B006）。
    const allScoresZero = Object.values(game.ledgerPlayers).every((ledger) => (game.scores[ledger.id] ?? 0) === 0);
    const pointsValidation = parseMahjongPoints(mahjongPoints);
    const transferBusy = transferState.phase === "sending" || transferState.phase === "retrying";
    const departedLedgerPlayers = Object.values(game.ledgerPlayers).filter((ledger) => !ledger.active);
    // 当前分数最高的玩家（并列都高亮；全为 0 时不显示王冠）。
    const maxScore = Math.max(...room.players.map((player) => game.scores[player.id] ?? 0), 0);
    const leaderIds = maxScore > 0 ? new Set(room.players.filter((player) => (game.scores[player.id] ?? 0) === maxScore).map((player) => player.id)) : null;
    return <main className="site-shell game-shell" key={screen}>
      {renderGameTopbar("麻将计分板")}
      <section className="game-heading" key="mahjong"><h1><span>麻将</span><br /><em>计分板</em></h1><p>{game.phase === "SETTLING" ? "结账方案已生成，按下方头像顺序互相结算即可。" : "点击其他玩家的头像，输入要给出的分数。"}</p></section>
      <section className="glass-card mahjong-card">
        <div className="card-header"><div><span className="section-kicker">当前分数</span></div><span className="mahjong-symbol" aria-hidden="true">🀄</span></div>
        <div className="mahjong-board">
          {room.players.map((player) => {
            const isSelf = player.id === room.localPlayerId;
            const score = game.scores[player.id] ?? 0;
            const isLeader = Boolean(leaderIds?.has(player.id));
            return <button key={player.id} type="button" data-player-id={player.id} className={`mahjong-tile${isLeader ? " mahjong-tile-leader" : ""}${mahjongTarget === player.id && transferPhase !== "exiting" && transferPhase !== "collapsing" ? " mahjong-tile-selected" : ""}${incomingId === player.id ? " player-incoming" : justJoinedId === player.id ? " just-joined" : ""}${isSelf ? " mahjong-tile-self" : ""}`} disabled={game.phase !== "PLAYING"} aria-disabled={isSelf} onClick={() => {
                if (isSelf) {
                  if (selfTileLongPressRef.current) {
                    selfTileLongPressRef.current = false;
                    return;
                  }
                  if (transferMode === "collect" && transferPhase !== "closed") {
                    closeMahjongTransfer();
                    return;
                  }
                  return;
                }
                selectMahjongTarget(player.id);
              }} onPointerDown={() => { if (isSelf && game.phase === "PLAYING") handleSelfTilePointerDown(); }} onPointerUp={handleSelfTilePointerUp} onPointerCancel={handleSelfTilePointerUp} onPointerLeave={handleSelfTilePointerUp} onContextMenu={(event) => { if (isSelf) event.preventDefault(); }}>
              {isLeader && (
                <span className="mahjong-tile-crown" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M12 3.5 15.8 8.2 21 6.2 18.6 15.5 5.4 15.5 3 6.2 8.2 8.2Z" />
                    <rect x="4.6" y="15" width="14.8" height="3" rx="1.5" />
                  </svg>
                </span>
              )}
              {isSelf && selfTileRing && (
                <span
                  key={selfTileRing.key}
                  className={`mahjong-tile-press-ring${selfTileRing.phase === "bursting" ? " mahjong-tile-press-ring-burst" : ""}`}
                  onAnimationEnd={() => { if (selfTileRing.phase === "bursting") setSelfTileRing(null); }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24" focusable="false">
                    <circle className="mahjong-tile-press-ring-track" cx="12" cy="12" r="9" />
                    <circle className="mahjong-tile-press-ring-fill" cx="12" cy="12" r="9" />
                  </svg>
                </span>
              )}
              <span className={`avatar avatar-${player.color}${game.settleReadyPlayerIds.includes(player.id) ? " avatar-settle-ready" : ""}${game.resetReadyPlayerIds.includes(player.id) ? " avatar-reset-ready" : ""}`}>{avatarFace(player.name, player.avatarData)}</span>
              <span className="mahjong-tile-name">{player.name}{isSelf && "（我）"}</span>
              {player.joinNextRound && <small className="join-next-label">下一局自动加入游戏</small>}
              <span className="mahjong-tile-score">{score}</span>
              {isSelf && game.phase === "PLAYING" && <small>长按向所有人收取</small>}
              {!isSelf && game.phase === "PLAYING" && <small>点击给出</small>}
            </button>;
          })}
          {departedLedgerPlayers.map((ledger) => {
            const score = game.scores[ledger.id] ?? 0;
            return <button key={ledger.id} type="button" className="mahjong-tile mahjong-tile-departed" disabled aria-label={`${ledger.name}，已离桌，分数 ${score}`}>
              <span className="avatar avatar-slate">{ledger.name.slice(0, 1)}</span>
              <span className="mahjong-tile-name">{ledger.name}<small>已离桌</small></span>
              <span className="mahjong-tile-score">{score}</span>
            </button>;
          })}
        </div>
        {game.phase === "PLAYING" &&
          transferPhase !== "closed" && (
            <div
              ref={transferSlotRef}
              className="mahjong-transfer-wrap"
              onTransitionEnd={handleTransferSlotTransitionEnd}
            >
              <div
                ref={transferStageRef}
                className="mahjong-transfer-stage"
              >
                <div
                  className={[
                    "mahjong-transfer",
                    `mahjong-transfer-${transferPhase}`,
                  ].join(" ")}
                  aria-hidden={
                    transferPhase === "preparing" ||
                    transferPhase === "expanding" ||
                    transferPhase === "collapsing"
                  }
                  onTransitionEnd={handleTransferPanelTransitionEnd}
                >
                  {transferMode === "collect" ? (
                    <>
                      <span className="field-label">向所有人收取的分数</span>
                      <div className="mahjong-transfer-row">
                        <span className="mahjong-adjust-wrap">
                          <input className={`text-input mahjong-points-input${mahjongAdjusting ? " mahjong-adjust-active" : ""}${!parseMahjongPoints(mahjongCollectPoints).ok && mahjongCollectPoints ? " input-error" : ""}`} type="number" min={1} max={99999} inputMode={finePointer ? "numeric" : "none"} readOnly={!finePointer || mahjongCollectSending} value={mahjongCollectPoints} aria-label="向所有人收取的分数" onChange={(event) => { if (!mahjongCollectSending) setMahjongCollectPoints(event.target.value); }} onPointerDown={handleMahjongPointsPointerDown} onPointerMove={handleMahjongPointsPointerMove} onPointerUp={handleMahjongPointsPointerUp} onPointerCancel={handleMahjongPointsPointerCancel} onContextMenu={(event) => event.preventDefault()} />
                          {mahjongRipple && <span key={mahjongRipple.key} className={`mahjong-adjust-ripple mahjong-adjust-ripple-${mahjongRipple.phase}`} onAnimationEnd={() => setMahjongRipple(null)} />}
                        </span>
                        <span className="mahjong-send-button-shell">
                          <button className={["button", "button-primary", "mahjong-send-button", mahjongCollectSending ? "mahjong-send-button-sending" : ""].filter(Boolean).join(" ")} type="button" aria-label="发起收取" aria-busy={mahjongCollectSending} disabled={!parseMahjongPoints(mahjongCollectPoints).ok || mahjongCollectSending} onClick={() => void sendMahjongCollect()}>
                            <span className="mahjong-send-arrow" aria-hidden="true">→</span>
                          </button>
                          <MahjongSendTrace active={mahjongCollectSending} />
                        </span>
                      </div>

                    </>
                  ) : targetPlayer ? (
                    <>
                      <span className="field-label">给 {targetPlayer.name} 的分数</span>
                  <div className="mahjong-transfer-row">
                    <span className="mahjong-adjust-wrap">
                      <input className={`text-input mahjong-points-input${mahjongAdjusting ? " mahjong-adjust-active" : ""}${!pointsValidation.ok && mahjongPoints ? " input-error" : ""}`} type="number" min={1} max={99999} inputMode={finePointer ? "numeric" : "none"} readOnly={!finePointer || transferBusy} value={mahjongPoints} aria-label="分数" onChange={(event) => { if (!transferBusy) setMahjongPoints(event.target.value); }} onPointerDown={handleMahjongPointsPointerDown} onPointerMove={handleMahjongPointsPointerMove} onPointerUp={handleMahjongPointsPointerUp} onPointerCancel={handleMahjongPointsPointerCancel} onContextMenu={(event) => event.preventDefault()} />
                      {mahjongRipple && <span key={mahjongRipple.key} className={`mahjong-adjust-ripple mahjong-adjust-ripple-${mahjongRipple.phase}`} onAnimationEnd={() => setMahjongRipple(null)} />}
                    </span>
                    <span className="mahjong-send-button-shell">
                      <button
                        className={["button", "button-primary", "mahjong-send-button", transferBusy ? "mahjong-send-button-sending" : ""].filter(Boolean).join(" ")}
                        type="button"
                        aria-label={transferBusy ? "正在确认分数" : "送出分数"}
                        aria-busy={transferBusy}
                        disabled={!pointsValidation.ok || transferBusy}
                        onClick={() => { void sendMahjongTransfer(targetPlayer.id); }}
                      >
                        <span className="mahjong-send-arrow" aria-hidden="true">→</span>
                      </button>
                      {/* 始终挂载，只切换 active，避免重新挂载时从头重播。 */}
                      <MahjongSendTrace active={transferBusy} />
                    </span>
                  </div>
                  {transferState.phase === "sending" || transferState.phase === "retrying" ? (
                    <p className="mahjong-transfer-status" role="status">
                      <FlipText
                        text={
                          transferWarnTier >= 2
                            ? "发送中，网络可能存在故障，请稍后……"
                            : transferWarnTier >= 1
                              ? "发送中，网络缓慢，请稍后……"
                              : "发送中……"
                        }
                      />
                    </p>
                  ) : transferState.phase === "rejected" ? (
                    <p className="mahjong-transfer-status mahjong-transfer-status-error" role="alert">
                      未发送：{transferState.error}。输入已保留，请检查后重新提交。
                    </p>
                  ) : null}
                    </>
                  ) : null}

                </div>
              </div>
            </div>
          )}
        {game.phase === "PLAYING" && (
          <div className="mahjong-collect-area">
            <AnimatePresence initial={false}>
              {(game.pendingCollects ?? [])
                .filter((collect) => collect.payerIds.includes(room.localPlayerId))
                .map((collect) => {
                  const progress = collect.payerIds.length > 0 ? collect.confirmedPlayerIds.length / collect.payerIds.length : 0;
                  const voted = collect.confirmedPlayerIds.includes(room.localPlayerId) || collect.rejectedBy === room.localPlayerId;
                  const collectorColor = room.players.find((player) => player.id === collect.collectorId)?.color ?? "slate";
                  return (
                    <m.div
                      layout
                      key={collect.id}
                      className="mahjong-collect-confirm"
                      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                      animate={{ opacity: 1, height: "auto", marginBottom: 10 }}
                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                      transition={motionTokens.layout}
                    >
                      <div className="mahjong-collect-confirm-inner">
                      <div className="mahjong-collect-confirm-head">
                        <span className={`avatar avatar-${collectorColor}`}>{collect.collectorName.slice(0, 1)}</span>
                        <div>
                          <strong>{collect.collectorName} 向所有人收取 {collect.points} 分</strong>
                        </div>
                      </div>
                      <div className="mahjong-collect-progress"><div className="mahjong-collect-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                      <div className="mahjong-collect-confirm-foot">
                        <small>{collect.confirmedPlayerIds.length}/{collect.payerIds.length} 已确认</small>
                        {voted ? (
                          <small className="mahjong-collect-voted">{collect.rejectedBy === room.localPlayerId ? "已否决" : "已确认"}</small>
                        ) : (
                          <span className="mahjong-collect-actions">
                            <button className="button button-primary" type="button" onClick={() => voteMahjongCollect(collect.id, true)}>确认</button>
                            <button className="button button-secondary" type="button" onClick={() => voteMahjongCollect(collect.id, false)}>否决</button>
                          </span>
                        )}
                      </div>
                      </div>
                    </m.div>
                  );
                })}
            </AnimatePresence>
          </div>
        )}
      </section>
      {renderPendingJoins()}
      {game.phase === "SETTLING" && game.settlement && <section className="glass-card mahjong-settle">
        <div className="card-header"><div><span className="section-kicker">结账方案</span><h2>按以下方式结算</h2></div><span className="mahjong-symbol" aria-hidden="true">➜</span></div>
        {game.settlement.transfers.length === 0
          ? <p className="mahjong-empty">分数已结清，无需互相结算。</p>
          : <div className="settle-list">
            {game.settlement.transfers.map((transfer, index) => (
              <div className="settle-row" key={`${transfer.fromPlayerId}-${transfer.toPlayerId}-${index}`}>
                <span className="settle-person"><span className={`avatar avatar-${room.players.find((player) => player.id === transfer.fromPlayerId)?.color ?? "slate"}`}>{transfer.fromPlayerName.slice(0, 1)}</span><small>{transfer.fromPlayerName}</small></span>
                <span className="settle-arrow" aria-hidden="true">→</span>
                <span className="settle-person"><span className={`avatar avatar-${room.players.find((player) => player.id === transfer.toPlayerId)?.color ?? "slate"}`}>{transfer.toPlayerName.slice(0, 1)}</span><small>{transfer.toPlayerName}</small></span>
                <span className="settle-points">{transfer.points} 分</span>
              </div>
            ))}
          </div>}
        <div className="vote-ready-wrap mahjong-settle-reset">
          <button className={hasResetReady ? "button button-secondary selected button-pop" : "button button-secondary large-button"} onClick={toggleMahjongResetReady}> 重置 <span>→</span></button>
          <ProgressBar count={resetReadyCount} total={allPlayerCount} />
        </div>
      </section>}
      <MahjongHistory history={game.history} players={room.players} />
      <div className="game-bottom">
        {game.phase !== "SETTLING" && <div className="vote-ready-wrap">
          <button className={hasSettleReady ? "button button-primary button-pop button-ready" : "button button-primary large-button"} onClick={toggleMahjongSettleReady} disabled={resetReadyCount > 0 || allScoresZero}> 结账 <span>→</span></button>
          <ProgressBar count={settleReadyCount} total={allPlayerCount} />
        </div>}
        {game.phase !== "SETTLING" && <div className="vote-ready-wrap">
          <button className={hasResetReady ? "button button-secondary selected button-pop" : "button button-secondary large-button"} onClick={toggleMahjongResetReady} disabled={settleReadyCount > 0}> 重置 <span>→</span></button>
          <ProgressBar count={resetReadyCount} total={allPlayerCount} />
        </div>}
      </div>
      {renderKickMenu()}
    </main>;
  };

  const renderGame = () => {
    if (!room) return null;
    const game = room.game;
    if (game?.kind === "undercover") return renderUndercoverGame(game);
    if (game?.kind === "challenge") return renderChallengeGame(game);
    if (game?.kind === "mahjong") return renderMahjongGame(game);
    return <main className="site-shell game-shell" key={screen}>
      {renderGameTopbar("对局中")}
      <section className="game-heading" key="stale"><span className="eyebrow">对局中</span><h1><span>等待</span><br /><em>房主操作</em></h1><p>当前游戏状态同步中，请稍候。</p></section>
    </main>;
  };

  const renderConfirmDialog = () => (
    <AnimatePresence>
      {confirmDialog && (
        <m.div key="confirm" className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={() => setConfirmDialog(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={motionTokens.overlay}>
          <m.div className="confirm-card" onClick={(event) => event.stopPropagation()} initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 6 }} transition={motionTokens.overlay}>
            <h2 id="confirm-title" className="confirm-title">{confirmDialog.title}</h2>
            <p className="confirm-message">{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button className="button button-secondary" type="button" onClick={() => setConfirmDialog(null)}>{confirmDialog.cancelLabel ?? "取消"}</button>
              <button className={`button button-primary${confirmDialog.tone === "danger" ? " button-danger" : ""}`} type="button" onClick={() => { const action = confirmDialog.onConfirm; setConfirmDialog(null); void action(); }}>{confirmDialog.confirmLabel}</button>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );

  const renderLeaveGameDialog = () => (
    <AnimatePresence>
      {leaveGameDialog && (
        <m.div key="leave-game" className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="leave-game-title" onClick={closeLeaveGameDialog} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={motionTokens.overlay}>
          <m.div className="confirm-card" onClick={(event) => event.stopPropagation()} initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 6 }} transition={motionTokens.overlay}>
            <h2 id="leave-game-title" className="confirm-title">返回大厅</h2>
            <p className="confirm-message">{"暂时离开：你返回大厅，其他玩家继续对局。\n结束游戏：所有人返回大厅，当前对局数据将清空。"}</p>
            <div className="confirm-actions leave-game-actions">
              <button className="button button-secondary" type="button" onClick={closeLeaveGameDialog}>取消</button>
              <button className="button button-primary" type="button" onClick={hostTemporarilyLeave}>暂时离开</button>
              <button className={`button button-secondary button-danger armed-target${endGameArmed ? " button-armed" : ""}`} type="button" onClick={handleEndGameClick}>结束游戏</button>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );

  const renderCamera = () => {
    if (!cameraOpen) return null;
    const cameraSwitchMounted = cameraSwitchVisible && (cameraPhase === "ready" || cameraPhase === "pre-closing");
    return <div className={`camera-overlay${cameraClosing ? " camera-overlay-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="camera-title"><div className="camera-card"><div className="camera-head"><h2 id="camera-title">扫描房间二维码</h2><button className="close-button" onClick={() => void closeScanner("button")} aria-label="关闭">×</button></div><div className="camera-view" data-phase={cameraPhase}><div className="camera-picture"><video ref={videoRef} muted playsInline /></div><div className="camera-aperture" aria-hidden="true"><i className="camera-aperture-edge camera-aperture-edge-top" /><i className="camera-aperture-edge camera-aperture-edge-bottom" /></div><div className="camera-scan-layer" aria-hidden="true"><div className="scan-frame"><i className="scan-corner scan-corner-tl" /><i className="scan-corner scan-corner-tr" /><i className="scan-corner scan-corner-bl" /><i className="scan-corner scan-corner-br" /></div></div>{cameraSwitchMounted && <button className="camera-switch-button" type="button" onClick={cameraPhase === "ready" ? switchCamera : undefined} aria-disabled={cameraPhase !== "ready"} tabIndex={cameraPhase === "ready" ? 0 : -1} aria-label="切换摄像头" title="切换摄像头"><svg className="camera-switch-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20 4h-3.17L15 2H9L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 11.5V13H9v2.5L5.5 12 9 8.5V11h6V8.5l3.5 3.5-3.5 3.5z" /></svg></button>}</div><p>{cameraMessage}</p><div className="camera-actions"><label className="button button-primary camera-upload-label">拍照或选择二维码图片<input type="file" accept="image/*" capture="environment" onChange={handleQrImage} /></label></div></div></div>;
  };

  // 这些回调定义在 handleServerMessage 之后，通过 effect 统一写入 ref（避免渲染期写 ref）。
  useEffect(() => {
    connectSocketRef.current = connectSocket;
    beginRequestExitRef.current = beginRequestExit;
    startJoinFlightRef.current = startJoinFlight;
    closeScannerRef.current = closeScanner;
    verifyJoinCodeRef.current = verifyJoinCode;
  }, [connectSocket, beginRequestExit, startJoinFlight, closeScanner, verifyJoinCode]);

  let content: React.ReactNode = renderHome();
  if (screen === "create") content = renderCreate();
  if (screen === "join") content = renderJoin();
  if (screen === "lobby") content = renderLobby();
  if (screen === "game") content = renderGame();
  // 游戏阶段/局数变化时也走同一套 Presence 切换（F020/F068）。
  const gamePhaseKey = room?.game
    ? `${room.gameId}-${"phase" in room.game ? String(room.game.phase) : ""}-${"round" in room.game ? room.game.round : ""}`
    : "";
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={`${screen}-${gamePhaseKey}`}
            className="screen-motion"
            initial={{ opacity: 0, y: 14, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.995 }}
            transition={motionTokens.screen}
          >
            {content}
          </m.div>
        </AnimatePresence>
        {renderJoinFlight()}
        {renderCamera()}
        {renderConfirmDialog()}
        {renderLeaveGameDialog()}
        {mahjongKeypadOpen && createPortal(
          <div ref={mahjongKeypadRef} className={`mahjong-keypad${mahjongKeypadClosing ? " mahjong-keypad-closing" : " mahjong-keypad-open"}`} onPointerDown={(event) => event.stopPropagation()}>
            <div className="mahjong-keypad-grid">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "→", "0", "⌫"].map((key) => (
                key === "⌫"
                  ? <button key={key} type="button" className="keypad-back" aria-label="删除一位" onPointerDown={handleKeypadBackspaceDown} onPointerUp={handleKeypadBackspaceUp} onPointerLeave={handleKeypadBackspaceUp} onPointerCancel={handleKeypadBackspaceUp} onContextMenu={(event) => event.preventDefault()}>⌫</button>
                  : <button key={key} type="button" className={key === "→" ? "keypad-ok" : undefined} disabled={key === "→" && ((transferState.phase === "sending" || transferState.phase === "retrying") || (transferMode === "collect" && mahjongCollectSending))} onClick={() => {
                    if (key === "→") {
                      // 与输入框右侧按钮相同的功能：发送（发送动画仍在输入框旁的按钮上）。
                      closeMahjongKeypad();
                      if (transferMode === "collect") {
                        void sendMahjongCollect();
                      } else if (mahjongTarget) {
                        void sendMahjongTransfer(mahjongTarget);
                      }
                    } else {
                      mahjongKeypadAppend(key);
                    }
                  }}>{key}</button>
              ))}
            </div>
          </div>,
          document.body,
        )}
        {room && wsStatus !== "open" && (
          <div className="connection-recovery-banner" role="status" aria-live="polite">
            <span className="connection-recovery-spinner" aria-hidden="true" />
            <strong>{reconnectPhase === "waiting-network" ? "网络已断开" : "正在恢复连接"}</strong>
          </div>
        )}
        {resuming && <div className="resume-banner" role="status" aria-live="polite"><span className="resume-spinner" aria-hidden="true" />正在回到之前的房间…</div>}
        <AnimatePresence>
          {collectRejectedNotice ? (
            <m.div
              key={`collect-rejected-${collectRejectedNotice.key}`}
              className="mahjong-collect-rejected"
              role="alert"
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={motionTokens.overlay}
            >
              <span>「{collectRejectedNotice.voterName}」否决了你的收取（{collectRejectedNotice.points} 分），该笔已作废</span>
              <button type="button" onClick={() => setCollectRejectedNotice(null)}>知道了</button>
            </m.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {notice ? (
            <m.div
              key="toast"
              className="toast"
              role="status"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={motionTokens.toast}
            >
              {notice}
            </m.div>
          ) : null}
        </AnimatePresence>
      </MotionConfig>
    </LazyMotion>
  );
}