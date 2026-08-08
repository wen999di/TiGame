/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic BOM/Taro compatibility bridge */
import Taro from "@tarojs/taro";
import { document as taroDocument, navigator as taroNavigator, window as taroWindow } from "@tarojs/runtime";

declare const __TIGAME_API_BASE__: string;

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

const apiBase = __TIGAME_API_BASE__.replace(/\/$/, "");
const root = globalThis as unknown as Record<string, any>;
// Taro 将源码里的 window / document / navigator 重写为 @tarojs/runtime 的 BOM 对象。
// 因此仅给 globalThis 打补丁并不能覆盖共享 Web 页面实际读取到的对象。
const win = taroWindow as unknown as Record<string, any>;
const globalWin = (root.window ?? root) as Record<string, any>;
const nav = taroNavigator as unknown as Record<string, any>;
const globalNav = (root.navigator ?? {}) as Record<string, any>;
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
root.localStorage = storage;
root.window ??= win;
root.document ??= taroDocument;
root.navigator ??= nav;

function patchWindow(target: Record<string, any>) {
  target.localStorage = storage;
  target.isSecureContext = true;
  target.requestAnimationFrame ??= (callback: FrameRequestCallback) => target.setTimeout(() => callback(Date.now()), 16);
  target.cancelAnimationFrame ??= (id: number) => target.clearTimeout(id);
  target.scrollY ??= 0;
  target.innerHeight ??= 800;
  target.innerWidth ??= 375;
  target.scrollTo ??= () => {};
  target.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  target.getComputedStyle ??= () => ({
    transform: "none",
    borderTopLeftRadius: "0px",
    getPropertyValue: () => "",
  });
}

function patchNavigator(target: Record<string, any>) {
  target.onLine = true;
  target.clipboard ??= { writeText: (text: string) => Taro.setClipboardData({ data: text }).then(() => undefined) };
  target.vibrate ??= () => { void Taro.vibrateShort({ type: "light" }); return true; };
}

patchWindow(win);
if (globalWin !== win) patchWindow(globalWin);
patchNavigator(nav);
if (globalNav !== nav) patchNavigator(globalNav);

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
