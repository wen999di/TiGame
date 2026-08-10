import { ScrollView } from "@tarojs/components";
import type { Player } from "../../../app/game/types";
import type { MahjongHistoryEntry } from "../../../app/game/mahjong";

function time(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function MahjongHistory({ history, players }: { history: readonly MahjongHistoryEntry[]; players: readonly Player[] }) {
  const colorById = new Map(players.map((player) => [player.id, player.color ?? "slate"]));
  const hasHistory = history.length > 0;
  const hasMore = history.length > 9;
  const listHeight = Math.min(history.length, 9.5) * 59;

  return (
    <section className="glass-card mahjong-history">
      <div className="card-header">
        <div><h2 className="mahjong-history-title">历史</h2></div>
        <span className="online-pill"><i />最新在前</span>
      </div>
      {hasMore && <p className="mahjong-history-hint">上下滑动查看更早记录</p>}
      {!hasHistory ? (
        <p className="mahjong-empty">还没有给出分数，点上方头像开始吧。</p>
      ) : (
        <ScrollView className="mahjong-history-list miniapp-mahjong-history-list" scrollY enhanced showScrollbar style={{ height: `${listHeight}px` }}>
          {history.map((entry) => {
            const fromColor = colorById.get(entry.fromPlayerId) ?? "slate";
            if (entry.kind === "collect") {
              return (
                <div className={`mahjong-history-row mahjong-history-row-collect${entry.status === "pending" ? " mahjong-history-row-pending" : ""}`} key={entry.id}>
                  <div className="mahjong-history-person">
                    <span className={`avatar avatar-${fromColor}`}>{entry.fromPlayerName.slice(0, 1)}</span>
                    <small>{entry.fromPlayerName}</small>
                  </div>
                  <div className="mahjong-history-arrow mahjong-history-arrow-collect">
                    <span className="mahjong-history-arrow-line" />
                    <small>{time(entry.at)}</small>
                  </div>
                  <div className="mahjong-history-payers">
                    {entry.payerNames.map((name, index) => (
                      <div className="mahjong-history-payer" key={`${entry.id}-${index}`}>
                        <small>{name}</small>
                        <span className={`avatar avatar-${colorById.get(entry.payerIds[index]) ?? "slate"}`}>{name.slice(0, 1)}</span>
                      </div>
                    ))}
                  </div>
                  <span className="mahjong-history-points">{entry.points}{entry.count > 1 ? <small className="mahjong-history-count">×{entry.count}</small> : <small className="mahjong-history-count" />}</span>
                  {entry.status === "pending" && <span className="mahjong-history-pending"><i />待确认</span>}
                </div>
              );
            }
            const toColor = colorById.get(entry.toPlayerId) ?? "slate";
            return (
              <div className="mahjong-history-row" key={entry.id}>
                <div className="mahjong-history-person">
                  <span className={`avatar avatar-${fromColor}`}>{entry.fromPlayerName.slice(0, 1)}</span>
                  <small>{entry.fromPlayerName}</small>
                </div>
                <div className="mahjong-history-arrow">
                  <span className="mahjong-history-arrow-line" />
                  <small>{time(entry.at)}</small>
                </div>
                <div className="mahjong-history-person mahjong-history-person-to">
                  <small>{entry.toPlayerName}</small>
                  <span className={`avatar avatar-${toColor}`}>{entry.toPlayerName.slice(0, 1)}</span>
                </div>
                <span className="mahjong-history-points">{entry.points}<small className="mahjong-history-count" /></span>
              </div>
            );
          })}
        </ScrollView>
      )}
    </section>
  );
}
