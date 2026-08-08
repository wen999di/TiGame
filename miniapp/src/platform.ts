/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic BOM/Taro compatibility bridge */
import Taro from "@tarojs/taro";

declare const __TIGAME_API_BASE__: string;

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

const apiBase = __TIGAME_API_BASE__.replace(/\/$/, "");
const root = globalThis as unknown as Record<string, any>;
const win = (root.window ?? root) as Record<string, any>;
const nav = (root.navigator ?? (root.navigator = {})) as Record<string, any>;
let shareRoomId = "";

function absoluteUrl(input: string) {
  if (/^https?:\/\//i.test(input)) return input;
  return `${apiBase}${input.startsWith("/") ? input : `/${input}`}`;
}

class MiniResponse {
  status: number;
  ok: boolean;
  private payload: unknown;
  constructor(status: number, payload: unknown) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.payload = payload;
  }
  async json() {
    if (typeof this.payload === "string") return JSON.parse(this.payload);
    return this.payload;
  }
  async text() {
    if (typeof this.payload === "string") return this.payload;
    return JSON.stringify(this.payload ?? null);
  }
}

async function miniFetch(input: string | URL, init: FetchInit = {}) {
  const request = Taro.request({
    url: absoluteUrl(String(input)),
    method: (init.method?.toUpperCase() || "GET") as any,
    header: init.headers,
    data: init.body,
    dataType: "json",
  }) as any;
  const abort = () => request.abort?.();
  init.signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await request;
    return new MiniResponse(response.statusCode, response.data) as unknown as Response;
  } finally {
    init.signal?.removeEventListener?.("abort", abort);
  }
}

class MiniWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = MiniWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  private task: any = null;

  constructor(url: string) {
    const connected = Taro.connectSocket({ url }) as any;
    const bind = (task: any) => {
      this.task = task;
      task.onOpen?.((event: unknown) => {
        this.readyState = MiniWebSocket.OPEN;
        this.onopen?.(event);
      });
      task.onMessage?.((event: { data: unknown }) => {
        const data = typeof event.data === "string" ? event.data : String(event.data ?? "");
        this.onmessage?.({ data });
      });
      task.onError?.((event: unknown) => this.onerror?.(event));
      task.onClose?.((event: { code?: number; reason?: string }) => {
        this.readyState = MiniWebSocket.CLOSED;
        this.onclose?.(event);
      });
    };
    if (connected && typeof connected.onOpen === "function") bind(connected);
    else Promise.resolve(connected).then(bind).catch((error) => {
      this.readyState = MiniWebSocket.CLOSED;
      this.onerror?.(error);
      this.onclose?.({ reason: "connect failed" });
    });
  }

  send(data: string) {
    if (this.readyState !== MiniWebSocket.OPEN || !this.task) throw new Error("WebSocket is not open");
    void this.task.send({ data });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === MiniWebSocket.CLOSED) return;
    this.readyState = MiniWebSocket.CLOSING;
    void this.task?.close?.({ code, reason });
  }
}

const storage = {
  getItem(key: string) {
    try {
      const value = Taro.getStorageSync(key);
      return value === undefined || value === null || value === "" ? null : String(value);
    } catch { return null; }
  },
  setItem(key: string, value: string) { Taro.setStorageSync(key, String(value)); },
  removeItem(key: string) { Taro.removeStorageSync(key); },
  clear() { Taro.clearStorageSync(); },
};

function currentInviteCode() {
  const instance = Taro.getCurrentInstance?.();
  const routeInvite = instance?.router?.params?.invite;
  if (typeof routeInvite === "string" && routeInvite) return routeInvite;
  try {
    const launch = Taro.getLaunchOptionsSync();
    const invite = launch.query?.invite;
    return typeof invite === "string" ? invite : "";
  } catch { return ""; }
}

root.__TIGAME_PLATFORM__ = {
  kind: "weapp",
  apiBase,
  webBase: apiBase,
  getInviteCode: currentInviteCode,
  clearInviteCode() {},
  async scanCode() {
    const result = await Taro.scanCode({ scanType: ["qrCode"] });
    return result.result || "";
  },
  setShareRoomId(roomId: string) { shareRoomId = roomId; },
  getShareRoomId() { return shareRoomId; },
};

root.fetch = miniFetch;
root.WebSocket = MiniWebSocket;
win.localStorage = storage;
win.isSecureContext = true;
win.requestAnimationFrame ??= (callback: FrameRequestCallback) => win.setTimeout(() => callback(Date.now()), 16);
win.cancelAnimationFrame ??= (id: number) => win.clearTimeout(id);
win.scrollY ??= 0;
win.innerHeight ??= 800;
win.innerWidth ??= 375;
win.scrollTo ??= () => {};
win.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.getComputedStyle ??= () => ({
  transform: "none",
  borderTopLeftRadius: "0px",
  getPropertyValue: () => "",
});
nav.onLine = true;
nav.clipboard = { writeText: (text: string) => Taro.setClipboardData({ data: text }).then(() => undefined) };
nav.vibrate = () => { void Taro.vibrateShort({ type: "light" }); return true; };

class NoopObserver {
  constructor(_callback?: (...args: any[]) => void) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
root.ResizeObserver ??= NoopObserver;
root.MutationObserver ??= NoopObserver;
root.IntersectionObserver ??= NoopObserver;
root.performance ??= { now: () => Date.now() };

void Taro.getNetworkType().then((result) => { nav.onLine = result.networkType !== "none"; }).catch(() => {});
Taro.onNetworkStatusChange?.((result) => { nav.onLine = result.isConnected; });
