"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

type MahjongSendTraceProps = {
  active: boolean;
};

type TraceGeometry = {
  width: number;
  height: number;
  inset: number;
  rx: number;
  ry: number;
};



/**
 * 从尾部到前端逐渐变亮。
 * 所有片段的 stroke-width 完全相同；这里只改变透明度，不改变几何宽度。
 */
const TRACE_OPACITIES = [
  0.07,
  0.11,
  0.16,
  0.23,
  0.32,
  0.43,
  0.55,
  0.68,
  0.81,
  0.91,
  1,
] as const;

/**
 * 相邻片段沿路径相隔的距离。
 * 每个片段长度在 CSS 中为 2.05，步距略小，相邻片段有极轻微重合，
 * 可避免高 DPI 屏幕上出现细小断点。
 */
const TRACE_SEGMENT_STEP = 1.9;
const ANIMATION_DURATION_SECONDS = 1.15;

function resolveCssLength(token: string, referenceSize: number): number {
  const normalized = token.trim();
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return 0;
  if (normalized.endsWith("%")) return (referenceSize * value) / 100;
  return value;
}

function readTopLeftRadius(
  style: CSSStyleDeclaration,
  width: number,
  height: number,
): { rx: number; ry: number } {
  const parts = style.borderTopLeftRadius.trim().split(/\\s+/);
  const horizontalToken = parts[0] ?? "0";
  const verticalToken = parts[1] ?? horizontalToken;
  return {
    rx: resolveCssLength(horizontalToken, width),
    ry: resolveCssLength(verticalToken, height),
  };
}

export function MahjongSendTrace({ active }: MahjongSendTraceProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [geometry, setGeometry] = useState<TraceGeometry>({
    width: 1,
    height: 1,
    inset: 1,
    rx: 0,
    ry: 0,
  });

  useEffect(() => {
    const svg = svgRef.current;
    const shell = svg?.parentElement;
    const button = shell?.querySelector<HTMLButtonElement>(".mahjong-send-button");
    if (!svg || !shell || !button) return;

    const updateGeometry = () => {
      // 使用按钮自身布局尺寸，而不是固定 100×100 viewBox，圆角不会因宽高比被非等比拉伸。
      let width = button.offsetWidth;
      let height = button.offsetHeight;
      if (width <= 0 || height <= 0) {
        const rect = button.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
      }
      if (width <= 0 || height <= 0) return;

      const style = window.getComputedStyle(button);
      const configuredStrokeWidth = Number.parseFloat(
        style.getPropertyValue("--mahjong-send-trace-width"),
      );
      const strokeWidth = Number.isFinite(configuredStrokeWidth) ? configuredStrokeWidth : 2;
      // SVG 描边以路径为中心向两边扩展：路径向内缩 strokeWidth / 2，
      // 描边外侧恰好与按钮外边缘重合。
      const inset = strokeWidth / 2;

      const outerRadius = readTopLeftRadius(style, width, height);
      const availableWidth = Math.max(0, width - inset * 2);
      const availableHeight = Math.max(0, height - inset * 2);
      // 中心线圆角 = 按钮外侧圆角 - inset，描边外侧圆角才与按钮完全一致。
      const rx = Math.max(0, Math.min(outerRadius.rx - inset, availableWidth / 2));
      const ry = Math.max(0, Math.min(outerRadius.ry - inset, availableHeight / 2));

      setGeometry((previous) => {
        const next = { width, height, inset, rx, ry };
        // 尺寸没有变化时避免无意义的 React 重渲染。
        if (
          previous.width === next.width &&
          previous.height === next.height &&
          previous.inset === next.inset &&
          previous.rx === next.rx &&
          previous.ry === next.ry
        ) {
          return previous;
        }
        return next;
      });
    };

    // 延迟一帧再测量，避免在 effect 内同步 setState 造成级联渲染。
    const frame = window.requestAnimationFrame(updateGeometry);

    const resizeObserver = new ResizeObserver(updateGeometry);
    resizeObserver.observe(button);

    // active 改变通常会改变按钮 class，在这里重新测量圆角或边框样式变化。
    const mutationObserver = new MutationObserver(updateGeometry);
    mutationObserver.observe(button, { attributes: true, attributeFilter: ["class", "style"] });

    window.addEventListener("resize", updateGeometry, { passive: true });

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateGeometry);
    };
  }, [active]);

  const traceWidth = Math.max(0, geometry.width - geometry.inset * 2);
  const traceHeight = Math.max(0, geometry.height - geometry.inset * 2);

  return (
    <svg
      ref={svgRef}
      className={["mahjong-send-trace", active ? "mahjong-send-trace-active" : ""].filter(Boolean).join(" ")}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      focusable="false"
      aria-hidden="true"
    >
      {/* reduced-motion 模式下使用的静态完整边框 */}
      <rect
        className="mahjong-send-trace-static"
        x={geometry.inset}
        y={geometry.inset}
        width={traceWidth}
        height={traceHeight}
        rx={geometry.rx}
        ry={geometry.ry}
        pathLength="100"
      />

      {TRACE_OPACITIES.map((opacity, index) => {
        // 更负的 delay 位于运动方向的前方，因此最后一段是最亮的前端。
        const animationDelay =
          -((index * TRACE_SEGMENT_STEP) / 100) * ANIMATION_DURATION_SECONDS;
        const style: CSSProperties = {
          strokeOpacity: opacity,
          animationDelay: `${animationDelay}s`,
        };
        const isTail = index === 0;
        const isPreHead = index === TRACE_OPACITIES.length - 2;
        const isHead = index === TRACE_OPACITIES.length - 1;

        return (
          <rect
            key={index}
            className={[
              "mahjong-send-trace-segment",
              isTail ? "mahjong-send-trace-tail" : "",
              isPreHead ? "mahjong-send-trace-pre-head" : "",
              isHead ? "mahjong-send-trace-head" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            x={geometry.inset}
            y={geometry.inset}
            width={traceWidth}
            height={traceHeight}
            rx={geometry.rx}
            ry={geometry.ry}
            pathLength="100"
            style={style}
          />
        );
      })}
    </svg>
  );
}
