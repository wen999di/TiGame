import { useEffect, useState } from "react";

type FlipTextProps = {
  text: string;
};

/**
 * 文字变更时播放上下翻转过渡：旧文字先向上翻出，新文字随后从下方翻入。
 * 首次挂载也会有一次轻微翻入，避免引入额外状态同步。
 */
export function FlipText({ text }: FlipTextProps) {
  const [current, setCurrent] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    if (text === current) return;
    // 延迟一帧再切换，避免在 effect 内同步 setState 造成级联渲染。
    const frame = window.requestAnimationFrame(() => {
      setLeaving(current);
      setCurrent(text);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [text, current]);

  return (
    <span className="mahjong-transfer-flip">
      <span key={`in-${current}`} className="mahjong-transfer-flip-in">
        {current}
      </span>
      {leaving !== null && (
        <span
          key={`out-${leaving}`}
          className="mahjong-transfer-flip-out"
          onAnimationEnd={() => setLeaving(null)}
        >
          {leaving}
        </span>
      )}
    </span>
  );
}
