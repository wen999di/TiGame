import type { Player } from "../../../app/game/types";
import type { MahjongHistoryEntry } from "../../../app/game/mahjong";

function time(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function MahjongHistory({ history }: { history: readonly MahjongHistoryEntry[]; players: readonly Player[] }) {
  if (history.length === 0) return <div className="mahjong-history-empty">还没有转分记录</div>;
  return (
    <div className="mahjong-history-wrap">
      <div className="mahjong-history-list">
        {history.slice(0, 40).map((entry) => (
          <div className="mahjong-history-row" key={entry.id}>
            <div className="mahjong-history-person"><span className="avatar">{entry.fromPlayerName.slice(0, 1)}</span><small>{entry.fromPlayerName}</small></div>
            <div className="mahjong-history-arrow"><span className="mahjong-history-arrow-line" /><small>{time(entry.at)}</small></div>
            <div className="mahjong-history-person mahjong-history-person-to"><small>{entry.toPlayerName}</small><span className="avatar">{entry.toPlayerName.slice(0, 1)}</span></div>
            <span className="mahjong-history-points">{entry.points}{entry.kind === "collect" && entry.count > 1 ? <small>×{entry.count}</small> : null}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
