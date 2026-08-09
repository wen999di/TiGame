/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic BOM/Taro compatibility bridge */
import Taro from "@tarojs/taro";
import { document as taroDocument, navigator as taroNavigator, window as taroWindow } from "@tarojs/runtime";
import { readWechatProfile, requestWechatProfile } from "./profile";

declare const __TIGAME_API_BASE__: string;
declare const __TIGAME_MINIAPP_DEBUG__: boolean;
declare const wx: {
  connectSocket?: (options: { url: string; tcpNoDelay?: boolean; success?: () => void; fail?: (error: unknown) => void }) => any;
};

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

class MiniDOMException extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
}

class MiniAbortSignal {
  aborted = false;
  private listeners = new Set<() => void>();

  addEventListener(type: string, listener: unknown) {
    if (type === "abort" && typeof listener === "function") this.listeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: unknown) {
    if (type === "abort" && typeof listener === "function") this.listeners.delete(listener as () => void);
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

class MiniAbortController {
  readonly signal = new MiniAbortSignal();
  abort() { this.signal.abort(); }
}

// 微信小程序 JSCore 并不保证存在浏览器的 AbortController / DOMException。
// 共享页面的创建房间超时逻辑依赖二者，所以必须在业务模块执行前补齐。
root.AbortController ??= MiniAbortController;
root.DOMException ??= MiniDOMException;
win.AbortController ??= root.AbortController;
win.DOMException ??= root.DOMException;
globalWin.AbortController ??= root.AbortController;
globalWin.DOMException ??= root.DOMException;

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
  const url = absoluteUrl(String(input));
  const method = init.method?.toUpperCase() || "GET";
  console.info(`[TiGame miniapp] request ${method} ${url}`);
  const request = Taro.request({
    url,
    method: method as any,
    header: init.headers,
    data: init.body,
    dataType: "json",
  }) as any;
  const abort = () => request.abort?.();
  init.signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await request;
    console.info(`[TiGame miniapp] response ${method} ${url}: ${response.statusCode}`);
    return new MiniResponse(response.statusCode, response.data) as unknown as Response;
  } catch (error) {
    console.error(`[TiGame miniapp] request failed: ${method} ${url}`, error);
    if (init.signal?.aborted) throw new MiniDOMException("The operation was aborted", "AbortError");
    if (method === "POST" && url.endsWith("/api/rooms")) {
      const detail = typeof (error as any)?.errMsg === "string" ? (error as any).errMsg : String(error);
      void Taro.showModal({ title: "创建房间请求失败", content: detail, showCancel: false });
    }
    throw error;
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
  private _onopen: ((event: unknown) => void) | null = null;
  private _onmessage: ((event: { data: string }) => void) | null = null;
  private _onerror: ((event: unknown) => void) | null = null;
  private _onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  private pendingOpen: unknown[] = [];
  private pendingMessages: Array<{ data: string }> = [];
  private pendingErrors: unknown[] = [];
  private pendingClose: Array<{ code?: number; reason?: string }> = [];
  private task: any = null;

  get onopen() { return this._onopen; }
  set onopen(handler: ((event: unknown) => void) | null) {
    this._onopen = handler;
    if (!handler) return;
    const queued = this.pendingOpen.splice(0);
    for (const event of queued) handler(event);
  }

  get onmessage() { return this._onmessage; }
  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this._onmessage = handler;
    if (!handler) return;
    const queued = this.pendingMessages.splice(0);
    for (const event of queued) handler(event);
  }

  get onerror() { return this._onerror; }
  set onerror(handler: ((event: unknown) => void) | null) {
    this._onerror = handler;
    if (!handler) return;
    const queued = this.pendingErrors.splice(0);
    for (const event of queued) handler(event);
  }

  get onclose() { return this._onclose; }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this._onclose = handler;
    if (!handler) return;
    const queued = this.pendingClose.splice(0);
    for (const event of queued) handler(event);
  }

  private emitOpen(event: unknown) {
    if (this._onopen) this._onopen(event);
    else this.pendingOpen.push(event);
  }

  private emitMessage(event: { data: string }) {
    if (this._onmessage) this._onmessage(event);
    else {
      this.pendingMessages.push(event);
      if (this.pendingMessages.length > 32) this.pendingMessages.shift();
    }
  }

  private emitError(event: unknown) {
    if (this._onerror) this._onerror(event);
    else this.pendingErrors.push(event);
  }

  private emitClose(event: { code?: number; reason?: string }) {
    if (this._onclose) this._onclose(event);
    else this.pendingClose.push(event);
  }

  constructor(url: string) {
    console.info(`[TiGame miniapp] WebSocket connecting: ${url}`);
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let terminal = false;
    const detailText = (detail: unknown) => typeof (detail as any)?.errMsg === "string"
      ? (detail as any).errMsg
      : typeof (detail as any)?.reason === "string" && (detail as any).reason
        ? (detail as any).reason
        : String(detail ?? "unknown");
    const debugNotice = (title: string, detail: unknown) => {
      if (!__TIGAME_MINIAPP_DEBUG__) return;
      void Taro.showModal({ title, content: `${url.replace(/\?.*$/, "")}\n${detailText(detail)}`.slice(0, 500), showCancel: false });
    };
    const fail = (title: string, detail: unknown) => {
      if (terminal) return;
      terminal = true;
      if (openTimer) clearTimeout(openTimer);
      this.readyState = MiniWebSocket.CLOSED;
      console.error(`[TiGame miniapp] ${title}: ${url}`, detail);
      debugNotice(title, detail);
      this.emitError(detail);
      try { void this.task?.close?.({ code: 1000, reason: "connect-failed" }); } catch {}
      this.emitClose({ code: 1006, reason: detailText(detail) });
    };
    const bind = (task: any) => {
      if (!task || typeof task.onOpen !== "function") throw new Error("微信没有返回 SocketTask");
      this.task = task;
      openTimer = setTimeout(() => {
        if (this.readyState === MiniWebSocket.CONNECTING) fail("WebSocket 连接超时", "8 秒内未收到 onOpen");
      }, 8_000);
      task.onOpen?.((event: unknown) => {
        if (terminal || this.readyState !== MiniWebSocket.CONNECTING) return;
        if (openTimer) clearTimeout(openTimer);
        this.readyState = MiniWebSocket.OPEN;
        console.info(`[TiGame miniapp] WebSocket open: ${url}`);
        this.emitOpen(event);
      });
      task.onMessage?.((event: { data: unknown }) => {
        if (terminal) return;
        this.emitMessage({ data: socketDataToString(event.data) });
      });
      task.onError?.((event: unknown) => fail("WebSocket 连接失败", event));
      task.onClose?.((event: { code?: number; reason?: string }) => {
        if (terminal) return;
        terminal = true;
        if (openTimer) clearTimeout(openTimer);
        this.readyState = MiniWebSocket.CLOSED;
        console.info(`[TiGame miniapp] WebSocket closed: ${url}`, event);
        this.emitClose(event);
      });
    };

    try {
      // 直接使用微信原生 SocketTask，并同时监听 connectSocket 的 fail 回调。
      // SocketTask 的 open/message 可能早于共享 React 页给 WebSocket.on* 赋值，
      // 因此上面会先缓存事件，赋值后再按顺序回放，避免丢掉首个 hello。
      const nativeTask = typeof wx !== "undefined"
        ? wx.connectSocket?.({
            url,
            tcpNoDelay: true,
            fail: (error: unknown) => setTimeout(() => fail("WebSocket 创建失败", error), 0),
          })
        : undefined;
      if (nativeTask && typeof nativeTask.onOpen === "function") {
        bind(nativeTask);
        return;
      }
      const connected = Taro.connectSocket({
        url,
        tcpNoDelay: true,
        fail: (error: unknown) => setTimeout(() => fail("WebSocket 创建失败", error), 0),
      } as any) as any;
      if (connected && typeof connected.onOpen === "function") bind(connected);
      else Promise.resolve(connected).then(bind).catch((error) => fail("WebSocket 创建失败", error));
    } catch (error) {
      fail("WebSocket 创建失败", error);
    }
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

function socketDataToString(data: unknown) {
  if (typeof data === "string") return data;
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    let result = "";
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++];
      if (first < 0x80) { result += String.fromCodePoint(first); continue; }
      if ((first & 0xe0) === 0xc0 && index < bytes.length) {
        result += String.fromCodePoint(((first & 0x1f) << 6) | (bytes[index++] & 0x3f));
        continue;
      }
      if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
        result += String.fromCodePoint(((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
        continue;
      }
      if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
        result += String.fromCodePoint(((first & 0x07) << 18) | ((bytes[index++] & 0x3f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
        continue;
      }
      result += "�";
    }
    return result;
  }
  return String(data ?? "");
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
  getUserProfile: readWechatProfile,
  ensureUserProfile: requestWechatProfile,
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
