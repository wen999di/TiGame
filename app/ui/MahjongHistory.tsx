import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, m } from "motion/react";
import { type Player } from "../game/types";
import { type MahjongHistoryEntry } from "../game/mahjong";

type HistoryMetrics = {
  scrollable: number;
  maxThumbTop: number;
};

type HistorySmoothState = {
  thumbCurrent: number;
  thumbTarget: number;
  scrollCurrent: number;
  scrollTarget: number;
};

type HistorySwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  /** 上一次移动时的 Y，用于增量拖动（避免与滚轮共享基准导致跳位）。 */
  lastY: number;
  startScrollTop: number;
  pageTargetY: number | null;
  timer: number | undefined;
  active: boolean;
};

type HistoryZoneSwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startThumbTop: number;
  timer: number | undefined;
  active: boolean;
};

type RippleState = { key: number; phase: "activate" | "release" } | null;

const LAYOUT_TRANSITION = { duration: 0.3, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] };

function formatTime(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** prefers-reduced-motion：JS 动画统一遵守（P1-16）。 */
function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

type MahjongHistoryRowsProps = {
  history: readonly MahjongHistoryEntry[];
  playerColorById: ReadonlyMap<string, string>;
};

/** 历史行列表：只在 history / 颜色索引变化时渲染；手势状态变化不触发。 */
const MahjongHistoryRows = memo(function MahjongHistoryRows({ history, playerColorById }: MahjongHistoryRowsProps) {
  return (
    <AnimatePresence initial={false}>
      {history.map((entry) => {
        const fromColor = playerColorById.get(entry.fromPlayerId) ?? "slate";
        if (entry.kind === "collect") {
          // 收取条目：左侧为收取方，箭头向左，右侧排列支付方头像，分数右下角标注 ×人数。
          return (
            <m.div
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={LAYOUT_TRANSITION}
              className={`mahjong-history-row mahjong-history-row-collect${entry.status === "pending" ? " mahjong-history-row-pending" : ""}`}
              key={entry.id}
            >
              <div className="mahjong-history-person">
                <span className={`avatar avatar-${fromColor}`}>{entry.fromPlayerName.slice(0, 1)}</span>
                <small>{entry.fromPlayerName}</small>
              </div>
              <div className="mahjong-history-arrow mahjong-history-arrow-collect">
                <span className="mahjong-history-arrow-line" aria-hidden="true" />
                <small>{formatTime(entry.at)}</small>
              </div>
              <div className="mahjong-history-payers">
                {entry.payerNames.map((name, index) => (
                  <div className="mahjong-history-payer" key={`${entry.id}-${index}`}>
                    <small>{name}</small>
                    <span className={`avatar avatar-${playerColorById.get(entry.payerIds[index]) ?? "slate"}`}>{name.slice(0, 1)}</span>
                  </div>
                ))}
              </div>
              <span className="mahjong-history-points">{entry.points}{entry.count > 1 ? <small className="mahjong-history-count">×{entry.count}</small> : <small className="mahjong-history-count" aria-hidden="true" />}</span>
              {entry.status === "pending" && <span className="mahjong-history-pending"><i aria-hidden="true" />待确认</span>}
            </m.div>
          );
        }
        const toColor = playerColorById.get(entry.toPlayerId) ?? "slate";
        return (
          <m.div
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={LAYOUT_TRANSITION}
            className="mahjong-history-row"
            key={entry.id}
          >
            <div className="mahjong-history-person">
              <span className={`avatar avatar-${fromColor}`}>{entry.fromPlayerName.slice(0, 1)}</span>
              <small>{entry.fromPlayerName}</small>
            </div>
            <div className="mahjong-history-arrow">
              <span className="mahjong-history-arrow-line" aria-hidden="true" />
              <small>{formatTime(entry.at)}</small>
            </div>
            <div className="mahjong-history-person mahjong-history-person-to">
              <small>{entry.toPlayerName}</small>
              <span className={`avatar avatar-${toColor}`}>{entry.toPlayerName.slice(0, 1)}</span>
            </div>
            <span className="mahjong-history-points">{entry.points}<small className="mahjong-history-count" aria-hidden="true" /></span>
          </m.div>
        );
      })}
    </AnimatePresence>
  );
});

/**
 * 麻将历史列表（独立组件，隔离手势状态，避免长按激活时重渲染整个页面）。
 * 功能与原实现完全一致：9.5 行展示、长按列表拖动、右侧圆点与热区拖动、
 * 顶部/底部阴影、新纪录自动回顶、圆点无过冲平滑跟随。
 */
export function MahjongHistory({ history, players }: { history: readonly MahjongHistoryEntry[]; players: readonly Player[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const hitZoneRef = useRef<HTMLSpanElement>(null);

  const [listReady, setListReady] = useState(false);
  const listRefCallback = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListReady(Boolean(node));
  }, []);

  const [scrollMode, setScrollMode] = useState(false);
  const [ripple, setRipple] = useState<RippleState>(null);
  const [thumbActive, setThumbActive] = useState(false);

  const metricsRef = useRef<HistoryMetrics>({ scrollable: 0, maxThumbTop: 0 });
  const thumbYRef = useRef(0);
  const smoothRef = useRef<HistorySmoothState | null>(null);
  const smoothRafRef = useRef<number | undefined>(undefined);
  // 会话滚动目标与拖动基准：拖动用“基准 + 手指总位移”的绝对目标，滚轮位移同步进基准。
  const historyDragBaselineRef = useRef(0);
  const historySessionTargetRef = useRef(0);
  const springRef = useRef<{ current: number; target: number; velocity: number } | null>(null);
  const springRafRef = useRef<number | undefined>(undefined);
  const scrollRafRef = useRef<number | undefined>(undefined);
  const scrollVisualRafRef = useRef<number | undefined>(undefined);
  const shadowStateRef = useRef({ hasTop: false, hasBottom: false });
  const listSwipeRef = useRef<HistorySwipeState | null>(null);
  const zoneSwipeRef = useRef<HistoryZoneSwipeState | null>(null);

  const thumbDragRef = useRef<{ pointerId: number; startY: number; startThumbTop: number } | null>(null);
  const prevNewestIdRef = useRef(history[0]?.id);

  const hasHistory = history.length > 0;
  const hasMoreHistory = history.length > 9;
  const reduceMotion = useReducedMotionPreference();

  // 颜色索引按稳定签名 memo：房间广播重建 players 数组时不会导致历史行重渲染（P2-02）。
  const playerColorSignature = players.map((player) => `${player.id}:${player.color ?? "slate"}`).join("|");
  const playerColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const player of players) map.set(player.id, player.color ?? "slate");
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerColorSignature]);

  /** 缓存滚动几何数据；仅在挂载/尺寸/数量变化/拖动开始时重新测量。 */
  const measureHistoryMetrics = useCallback((): HistoryMetrics => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    const thumb = thumbRef.current;
    if (!list || !wrap || !thumb) {
      metricsRef.current = { scrollable: 0, maxThumbTop: 0 };
      return metricsRef.current;
    }
    const metrics = {
      scrollable: Math.max(0, list.scrollHeight - list.clientHeight),
      maxThumbTop: Math.max(0, wrap.clientHeight - thumb.offsetHeight),
    };
    metricsRef.current = metrics;
    return metrics;
  }, []);

  /** 圆点位移统一走 transform，只触发合成层。 */
  const writeHistoryThumbY = useCallback((value: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    thumbYRef.current = value;
    thumb.style.transform = `translate3d(0, ${value.toFixed(3)}px, 0)`;
  }, []);

  /** 取消遗留的弹簧动画，避免它和拖动平滑循环抢占圆点位置导致跳动。 */
  const cancelHistorySpring = useCallback(() => {
    if (springRafRef.current !== undefined) {
      cancelAnimationFrame(springRafRef.current);
      springRafRef.current = undefined;
    }
    springRef.current = null;
  }, []);

  /** 顶部/底部阴影类名，带状态缓存，只在变化时切换。 */
  const updateHistoryShadowClasses = useCallback((scrollTop: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { scrollable } = metricsRef.current;
    const hasTop = scrollTop > 4;
    const hasBottom = scrollable - scrollTop > 4;
    const previous = shadowStateRef.current;
    if (previous.hasTop !== hasTop) {
      previous.hasTop = hasTop;
      wrap.classList.toggle("history-scrolled-top", hasTop);
    }
    if (previous.hasBottom !== hasBottom) {
      previous.hasBottom = hasBottom;
      wrap.classList.toggle("history-scrolled-bottom", hasBottom);
    }
  }, []);

  /** 长按激活时的页面定位补间动画。 */
  const animateHistoryScrollTo = useCallback((targetY: number) => {
    if (reduceMotion) {
      window.scrollTo(0, targetY);
      return;
    }
    if (scrollRafRef.current !== undefined) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    const startY = window.scrollY;
    const delta = targetY - startY;
    if (Math.abs(delta) < 1) return;
    const duration = 280;
    const startTime = performance.now();
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / duration);
      window.scrollTo(0, startY + delta * ease(progress));
      if (progress < 1) {
        scrollRafRef.current = requestAnimationFrame(step);
      } else {
        scrollRafRef.current = undefined;
      }
    };
    scrollRafRef.current = requestAnimationFrame(step);
  }, [reduceMotion]);

  /** 长按激活前预计算页面定位目标（按下时读取，避免激活帧卡顿）。 */
  const calculateHistoryPageTarget = useCallback((): number | null => {
    const list = listRef.current;
    if (!list) return null;
    const rect = list.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const gap = 20;
    if (rect.height <= viewportHeight) {
      if (rect.top < gap) return Math.max(0, window.scrollY + rect.top - gap);
      if (rect.bottom > viewportHeight - gap) return Math.max(0, window.scrollY + rect.bottom - viewportHeight + gap);
      return null;
    }
    return Math.max(0, window.scrollY + rect.top + rect.height / 2 - viewportHeight / 2);
  }, []);

  /** 拖动期间统一的无过冲平滑：每帧只做数字运算 + 写入 scrollTop/transform/阴影。 */

  const driveHistorySmooth = useCallback((rawThumbTarget: number, rawScrollTarget: number) => {
    const list = listRef.current;
    if (!list) return;
    cancelHistorySpring();
    if (reduceMotion) {
      // reduced-motion：直接定位，不做 rAF 插值。
      const { scrollable, maxThumbTop } = metricsRef.current;
      const nextScroll = clamp(rawScrollTarget, 0, scrollable);
      const nextThumb = clamp(rawThumbTarget, 0, maxThumbTop);
      list.scrollTop = nextScroll;
      writeHistoryThumbY(nextThumb);
      updateHistoryShadowClasses(nextScroll);
      return;
    }
    const { scrollable, maxThumbTop } = metricsRef.current;
    const thumbTarget = clamp(rawThumbTarget, 0, maxThumbTop);
    const scrollTarget = clamp(rawScrollTarget, 0, scrollable);

    let state = smoothRef.current;
    if (!state) {
      state = {
        thumbCurrent: thumbYRef.current,
        thumbTarget,
        scrollCurrent: list.scrollTop,
        scrollTarget,
      };
      smoothRef.current = state;
    } else {
      state.thumbTarget = thumbTarget;
      state.scrollTarget = scrollTarget;
    }
    if (smoothRafRef.current !== undefined) return;

    const step = () => {
      const current = smoothRef.current;
      const listElement = listRef.current;
      if (!current || !listElement) {
        smoothRafRef.current = undefined;
        smoothRef.current = null;
        return;
      }
      const latest = metricsRef.current;
      const clampedScrollTarget = clamp(current.scrollTarget, 0, latest.scrollable);
      const clampedThumbTarget = clamp(current.thumbTarget, 0, latest.maxThumbTop);
      const smoothing = 0.22;
      const nextScroll = current.scrollCurrent + (clampedScrollTarget - current.scrollCurrent) * smoothing;
      const nextThumb = current.thumbCurrent + (clampedThumbTarget - current.thumbCurrent) * smoothing;
      current.scrollCurrent = nextScroll;
      current.thumbCurrent = nextThumb;
      listElement.scrollTop = nextScroll;
      writeHistoryThumbY(nextThumb);
      updateHistoryShadowClasses(nextScroll);
      if (Math.abs(clampedScrollTarget - nextScroll) < 0.5 && Math.abs(clampedThumbTarget - nextThumb) < 0.5) {
        current.scrollCurrent = clampedScrollTarget;
        current.thumbCurrent = clampedThumbTarget;
        listElement.scrollTop = clampedScrollTarget;
        writeHistoryThumbY(clampedThumbTarget);
        updateHistoryShadowClasses(clampedScrollTarget);
        smoothRafRef.current = undefined;
        smoothRef.current = null;
        return;
      }
      smoothRafRef.current = requestAnimationFrame(step);
    };
    smoothRafRef.current = requestAnimationFrame(step);
  }, [cancelHistorySpring, reduceMotion, updateHistoryShadowClasses, writeHistoryThumbY]);

  /** 非拖动滚动（如新纪录自动回顶）时圆点的无过冲跟随，只使用缓存的几何数据。 */
  const updateHistoryThumbFromScroll = useCallback((scrollTop: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    if (thumbDragRef.current || zoneSwipeRef.current?.active || smoothRef.current) return;
    const { scrollable, maxThumbTop } = metricsRef.current;
    if (scrollable <= 0) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "1";
    const targetTop = clamp(scrollTop / scrollable, 0, 1) * maxThumbTop;
    if (reduceMotion) {
      writeHistoryThumbY(targetTop);
      return;
    }
    let spring = springRef.current;
    if (!spring) {
      spring = { current: thumbYRef.current, target: targetTop, velocity: 0 };
      springRef.current = spring;
    } else {
      spring.target = targetTop;
    }
    if (springRafRef.current !== undefined) return;
    const step = () => {
      const state = springRef.current;
      if (!state || !thumbRef.current) {
        if (springRafRef.current !== undefined) springRafRef.current = undefined;
        return;
      }
      state.current += (state.target - state.current) * 0.18;
      writeHistoryThumbY(state.current);
      if (Math.abs(state.target - state.current) < 0.5) {
        state.current = state.target;
        writeHistoryThumbY(state.target);
        springRafRef.current = undefined;
        return;
      }
      springRafRef.current = requestAnimationFrame(step);
    };
    springRafRef.current = requestAnimationFrame(step);
  }, [reduceMotion, writeHistoryThumbY]);


  /** 圆点/热区拖动：根据圆点起始位置与位移换算（只读缓存）。 */
  const dragHistoryThumbTo = useCallback((clientY: number, startY: number, startThumbTop: number) => {
    const { scrollable, maxThumbTop } = metricsRef.current;
    const nextTop = clamp(startThumbTop + clientY - startY, 0, maxThumbTop);
    const scrollTarget = maxThumbTop > 0 ? (nextTop / maxThumbTop) * scrollable : 0;
    driveHistorySmooth(nextTop, scrollTarget);
  }, [driveHistorySmooth]);

  // ---- 列表手势（指针：鼠标/触控笔） ----

  const cancelListScroll = useCallback(() => {
    const swipe = listSwipeRef.current;
    if (swipe?.timer !== undefined) window.clearTimeout(swipe.timer);
    if (swipe?.active) {
      setScrollMode(false);
      setRipple({ key: Date.now(), phase: "release" });
    } else {
      setRipple(null);
    }
    listSwipeRef.current = null;
  }, []);

  const handleListPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelListScroll();
    cancelHistorySpring();
    const el = listRef.current;
    if (!el) return;
    historyDragBaselineRef.current = el.scrollTop;
    historySessionTargetRef.current = el.scrollTop;
    measureHistoryMetrics();
    const swipe: HistorySwipeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      startScrollTop: el.scrollTop,
      pageTargetY: calculateHistoryPageTarget(),
      timer: undefined,
      active: false,
    };
    listSwipeRef.current = swipe;
    swipe.timer = window.setTimeout(() => {
      if (listSwipeRef.current !== swipe) return;
      swipe.active = true;
      setScrollMode(true);
      setRipple({ key: Date.now(), phase: "activate" });
      if (swipe.pageTargetY !== null) {
        animateHistoryScrollTo(swipe.pageTargetY);
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 捕获失败不影响后续移动滚动。
      }
    }, 450);
  }, [animateHistoryScrollTo, calculateHistoryPageTarget, cancelHistorySpring, cancelListScroll, measureHistoryMetrics]);

  const handleListPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = listSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (!swipe.active) {
      if (Math.abs(event.clientY - swipe.startY) > 10 || Math.abs(event.clientX - swipe.startX) > 10) {
        cancelListScroll();
      }
      return;
    }
    const el = listRef.current;
    if (!el) return;
    const { scrollable, maxThumbTop } = metricsRef.current;
    // 绝对目标：基准 + 手指总位移；平滑循环只做过渡，最终落点与手指总位移一致。
    const totalDelta = swipe.startY - event.clientY;
    const scrollTarget = clamp(historyDragBaselineRef.current + totalDelta, 0, scrollable);
    historySessionTargetRef.current = scrollTarget;
    const thumbTarget = scrollable > 0 && maxThumbTop > 0 ? (scrollTarget / scrollable) * maxThumbTop : 0;
    driveHistorySmooth(thumbTarget, scrollTarget);
  }, [cancelListScroll, driveHistorySmooth]);

  const handleListPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = listSwipeRef.current;
    if (swipe && swipe.pointerId === event.pointerId) cancelListScroll();
  }, [cancelListScroll]);

  // ---- 右侧热区手势 ----

  const activateZoneDrag = useCallback((pointerId: number, startX: number, startY: number, target: Element | null) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    zoneSwipeRef.current = { pointerId, startX, startY, startThumbTop: thumbYRef.current, timer: undefined, active: true };
    setThumbActive(true);
    setRipple({ key: Date.now(), phase: "activate" });
    try {
      target?.setPointerCapture?.(pointerId);
    } catch {
      // 触摸路径无需指针捕获。
    }
  }, []);

  const endZoneDrag = useCallback(() => {
    if (zoneSwipeRef.current?.active) {
      setThumbActive(false);
      setRipple({ key: Date.now(), phase: "release" });
    }
    zoneSwipeRef.current = null;
  }, []);

  const cancelZoneDrag = useCallback(() => {
    const swipe = zoneSwipeRef.current;
    if (swipe?.timer !== undefined) window.clearTimeout(swipe.timer);
    if (swipe?.active) setThumbActive(false);
    zoneSwipeRef.current = null;
  }, []);

  const handleZonePointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    // 非 primary 指针（第二根手指）：取消组件拖动，交给浏览器正常手势。
    if (!event.isPrimary) {
      cancelZoneDrag();
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelZoneDrag();
    cancelHistorySpring();
    const thumb = thumbRef.current;
    if (!thumb) return;
    measureHistoryMetrics();
    const swipe: HistoryZoneSwipeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startThumbTop: thumbYRef.current,
      timer: undefined,
      active: false,
    };
    zoneSwipeRef.current = swipe;
    swipe.timer = window.setTimeout(() => {
      if (zoneSwipeRef.current !== swipe) return;
      activateZoneDrag(swipe.pointerId, swipe.startX, swipe.startY, event.currentTarget);
    }, 450);
  }, [activateZoneDrag, cancelHistorySpring, cancelZoneDrag, measureHistoryMetrics]);

  const handleZonePointerMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!event.isPrimary) {
      cancelZoneDrag();
      return;
    }
    const swipe = zoneSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (!swipe.active) {
      if (Math.abs(event.clientY - swipe.startY) > 10 || Math.abs(event.clientX - swipe.startX) > 10) {
        cancelZoneDrag();
      }
      return;
    }
    event.preventDefault();
    dragHistoryThumbTo(event.clientY, swipe.startY, swipe.startThumbTop);
  }, [cancelZoneDrag, dragHistoryThumbTo]);

  const handleZonePointerUp = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const swipe = zoneSwipeRef.current;
    if (swipe && swipe.pointerId === event.pointerId) endZoneDrag();
  }, [endZoneDrag]);

  // ---- 圆点自身手势 ----

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const thumb = thumbRef.current;
    if (!thumb) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelHistorySpring();
    measureHistoryMetrics();
    thumbDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startThumbTop: thumbYRef.current,
    };
  }, [cancelHistorySpring, measureHistoryMetrics]);

  const handleThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = thumbDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragHistoryThumbTo(event.clientY, drag.startY, drag.startThumbTop);
  }, [dragHistoryThumbTo]);

  const handleThumbPointerUp = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (thumbDragRef.current?.pointerId === event.pointerId) {
      thumbDragRef.current = null;
    }
  }, []);

  // 挂载/数量/尺寸变化时重新测量几何数据。
  useLayoutEffect(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    const thumb = thumbRef.current;
    if (!list || !wrap || !thumb) return;
    const resizeObserver = new ResizeObserver(() => {
      measureHistoryMetrics();
    });
    resizeObserver.observe(list);
    resizeObserver.observe(wrap);
    resizeObserver.observe(thumb);
    measureHistoryMetrics();
    return () => {
      resizeObserver.disconnect();
    };
  }, [history.length, listReady, measureHistoryMetrics]);

  // 新纪录出现：取消所有进行中的手势/动画，并自动回到最上面（P1-12/P1-13）。
  const cancelAllHistoryGestures = useCallback(() => {
    cancelListScroll();
    cancelZoneDrag();
    cancelHistorySpring();
    if (smoothRafRef.current !== undefined) cancelAnimationFrame(smoothRafRef.current);
    smoothRafRef.current = undefined;
    smoothRef.current = null;
    thumbDragRef.current = null;
  }, [cancelHistorySpring, cancelListScroll, cancelZoneDrag]);

  useEffect(() => {
    const newestId = history[0]?.id;
    const el = listRef.current;
    if (newestId && newestId !== prevNewestIdRef.current && el) {
      cancelAllHistoryGestures();
      if (reduceMotion) {
        el.scrollTop = 0;
      } else {
        el.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    prevNewestIdRef.current = newestId;
  }, [cancelAllHistoryGestures, history, reduceMotion]);

  // 列表触摸：原生监听（React touchmove 是 passive，无法 preventDefault）。
  useEffect(() => {
    const el = listRef.current;
    if (!el || !hasHistory || !listReady) return;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      cancelListScroll();
      cancelHistorySpring();
      historyDragBaselineRef.current = el.scrollTop;
      historySessionTargetRef.current = el.scrollTop;
      measureHistoryMetrics();
      const swipe: HistorySwipeState = {
        pointerId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
        startScrollTop: el.scrollTop,
        pageTargetY: calculateHistoryPageTarget(),
        timer: undefined,
        active: false,
      };
      listSwipeRef.current = swipe;
      swipe.timer = window.setTimeout(() => {
        if (listSwipeRef.current !== swipe) return;
        swipe.active = true;
        setScrollMode(true);
        setRipple({ key: Date.now(), phase: "activate" });
        if (swipe.pageTargetY !== null) {
          animateHistoryScrollTo(swipe.pageTargetY);
        }
      }, 450);
    };

    const onTouchMove = (event: TouchEvent) => {
      const swipe = listSwipeRef.current;
      if (!swipe) return;
      const touch = Array.from(event.touches).find((item) => item.identifier === swipe.pointerId);
      if (!touch) return;
      if (!swipe.active) {
        if (Math.abs(touch.clientY - swipe.startY) > 10 || Math.abs(touch.clientX - swipe.startX) > 10) {
          cancelListScroll();
        }
        return;
      }
      event.preventDefault();
      const { scrollable, maxThumbTop } = metricsRef.current;
      // 绝对目标：基准 + 手指总位移；平滑循环只做过渡，最终落点与手指总位移一致。
      const totalDelta = swipe.startY - touch.clientY;
      const scrollTarget = clamp(historyDragBaselineRef.current + totalDelta, 0, scrollable);
      historySessionTargetRef.current = scrollTarget;
      const thumbTarget = scrollable > 0 && maxThumbTop > 0 ? (scrollTarget / scrollable) * maxThumbTop : 0;
      driveHistorySmooth(thumbTarget, scrollTarget);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const swipe = listSwipeRef.current;
      if (!swipe) return;
      if (Array.from(event.changedTouches).some((item) => item.identifier === swipe.pointerId)) {
        cancelListScroll();
      }
    };

    // 电脑端：仅“长按拖动会话激活”（鼠标左键按下）时，滚轮滚动历史列表，不滚动页面；
    // 松开左键后会话结束，滚轮不再接管。
    const onWheel = (event: WheelEvent) => {
      const swipe = listSwipeRef.current;
      if (!swipe?.active) return;
      const list = listRef.current;
      if (!list) return;
      event.preventDefault();
      const { scrollable, maxThumbTop } = metricsRef.current;
      // 灵敏度缩放：单次事件最多约 80px，鼠标一格（约 100-120px）只滚动一半左右。
      const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      const scaled = clamp(deltaY * 0.45, -80, 80);
      // 基于会话目标增量滚动，并把位移同步进拖动基准，滚轮与拖动交替不会跳位。
      const scrollTarget = clamp(historySessionTargetRef.current + scaled, 0, scrollable);
      historySessionTargetRef.current = scrollTarget;
      historyDragBaselineRef.current = clamp(historyDragBaselineRef.current + scaled, 0, scrollable);
      const thumbTarget = scrollable > 0 && maxThumbTop > 0 ? (scrollTarget / scrollable) * maxThumbTop : 0;
      // 交给统一平滑循环：圆点与列表一起平滑移动（无过冲）。
      driveHistorySmooth(thumbTarget, scrollTarget);
    };

    // scroll 事件按帧合并；手动平滑循环已同步处理圆点与阴影，直接跳过。
    const onHistoryScroll = () => {
      if (smoothRef.current) return;
      if (scrollVisualRafRef.current !== undefined) return;
      scrollVisualRafRef.current = requestAnimationFrame(() => {
        scrollVisualRafRef.current = undefined;
        const list = listRef.current;
        if (!list) return;
        const scrollTop = list.scrollTop;
        updateHistoryShadowClasses(scrollTop);
        updateHistoryThumbFromScroll(scrollTop);
      });
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onHistoryScroll, { passive: true });
    onHistoryScroll();
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onHistoryScroll);
      el.parentElement?.classList.remove("history-scrolled-top", "history-scrolled-bottom");
    };
  }, [
    animateHistoryScrollTo,

    calculateHistoryPageTarget,
    cancelHistorySpring,
    cancelListScroll,
    driveHistorySmooth,
    hasHistory,
    listReady,
    measureHistoryMetrics,
    updateHistoryShadowClasses,
    updateHistoryThumbFromScroll,
  ]);


  // 卸载清理：所有动画帧与未触发的长按计时器。
  useEffect(() => () => {
    if (scrollRafRef.current !== undefined) cancelAnimationFrame(scrollRafRef.current);
    if (scrollVisualRafRef.current !== undefined) cancelAnimationFrame(scrollVisualRafRef.current);
    if (springRafRef.current !== undefined) cancelAnimationFrame(springRafRef.current);
    if (smoothRafRef.current !== undefined) cancelAnimationFrame(smoothRafRef.current);
    smoothRafRef.current = undefined;
    smoothRef.current = null;
    const listSwipe = listSwipeRef.current;
    if (listSwipe?.timer !== undefined) window.clearTimeout(listSwipe.timer);
    const zoneSwipe = zoneSwipeRef.current;
    if (zoneSwipe?.timer !== undefined) window.clearTimeout(zoneSwipe.timer);
  }, []);

  return (
    <section className="glass-card mahjong-history">
      <div className="card-header"><div><h2 className="mahjong-history-title">历史</h2></div><span className="online-pill"><i />最新在前</span></div>
      {hasMoreHistory && <p className="mahjong-history-hint">长按列表可上下滑动查看更早记录</p>}
      {!hasHistory
        ? <p className="mahjong-empty">还没有给出分数，点上方头像开始吧。</p>
        : <div ref={wrapRef} className={`mahjong-history-scroll-wrap${hasMoreHistory ? " has-more" : ""}`}>
          <div
            ref={listRefCallback}
            className={`mahjong-history-list${scrollMode ? " history-scrolling" : ""}`}
            onPointerDown={(event) => { if (event.pointerType !== "touch") handleListPointerDown(event); }}
            onPointerMove={(event) => { if (event.pointerType !== "touch") handleListPointerMove(event); }}
            onPointerUp={(event) => { if (event.pointerType !== "touch") handleListPointerUp(event); }}
            onPointerCancel={(event) => { if (event.pointerType !== "touch") handleListPointerUp(event); }}
            onLostPointerCapture={(event) => { if (event.pointerType !== "touch") handleListPointerUp(event); }}
          >
            <MahjongHistoryRows history={history} playerColorById={playerColorById} />
          </div>
          {ripple && <span key={ripple.key} className={`mahjong-history-scroll-ripple mahjong-history-scroll-ripple-${ripple.phase}`} onAnimationEnd={() => setRipple(null)} aria-hidden="true" />}
          {hasMoreHistory && (
            <>
              <span
                ref={thumbRef}
                className={`mahjong-history-scroll-thumb${thumbActive ? " thumb-active" : ""}`}
                onPointerDown={handleThumbPointerDown}
                onPointerMove={handleThumbPointerMove}
                onPointerUp={handleThumbPointerUp}
                onPointerCancel={handleThumbPointerUp}
                onLostPointerCapture={handleThumbPointerUp}
                aria-hidden="true"
              >
                <span className="mahjong-history-scroll-thumb-visual" />
              </span>
              <span
                ref={hitZoneRef}
                className="mahjong-history-scroll-hit-zone"
                onPointerDown={handleZonePointerDown}
                onPointerMove={handleZonePointerMove}
                onPointerUp={handleZonePointerUp}
                onPointerCancel={handleZonePointerUp}
                onLostPointerCapture={handleZonePointerUp}
                aria-hidden="true"
              />
            </>
          )}
        </div>}
    </section>
  );
}