import React from "react";
import { fmtInt, fmtTokensShort, mmdd, todayStr } from "../format";

export type StackedPoint = {
  date: string;
  hit: number;
  miss: number;
  response: number;
  other: number;
  total: number;
  unavailable?: boolean;
};

// 主面板与详情共用交互：指向预览、点击固定、Escape 收起；明细占独立区域。
function StackedBarChart({
  points,
  variant,
  hasOther,
}: {
  points: StackedPoint[];
  variant: "summary" | "detail";
  hasOther: boolean;
}) {
  const [hoveredDate, setHoveredDate] = React.useState<string | null>(null);
  const [focusedDate, setFocusedDate] = React.useState<string | null>(null);
  const [pinnedDate, setPinnedDate] = React.useState<string | null>(null);
  // React 按日期复用按钮；跨日窗口位移时，交互身份也必须跟随同一日期。
  // 当前渲染先过滤移出的日期，不能等 effect 后才避免播报另一根柱子的值。
  const pinned = points.find((point) => point.date === pinnedDate);
  const focused = points.find((point) => point.date === focusedDate);
  const hovered = points.find((point) => point.date === hoveredDate);
  const active = pinned ?? focused ?? hovered;
  React.useEffect(() => {
    const dates = new Set(points.map((point) => point.date));
    const retainVisible = (date: string | null) =>
      date != null && dates.has(date) ? date : null;
    // 清掉失效身份，之后同一日期重新进入窗口时不能自行恢复旧预览／固定态。
    setHoveredDate(retainVisible);
    setFocusedDate(retainVisible);
    setPinnedDate(retainVisible);
  }, [points]);
  const dismiss = () => {
    setPinnedDate(null);
    setFocusedDate(null);
    setHoveredDate(null);
  };
  React.useEffect(() => {
    if (pinnedDate == null) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinnedDate(null);
        setFocusedDate(null);
        setHoveredDate(null);
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [pinnedDate]);
  const MIN_BAR = 3; // 整根柱子的最小可见高度百分比（含空数据占位）
  const maxVal = Math.max(...points.map((point) => point.total), 1);
  const isSummary = variant === "summary";

  return (
    <>
      <div
        className={isSummary ? "bars" : "detail-bars"}
        onMouseLeave={() => setHoveredDate(null)}
      >
        {points.map((point, idx) => {
          // 键盘用户与读屏用户拿到的是同一条信息：日期、合计与各分段明细
          const label = point.unavailable
            ? `${point.date}：数据暂未取得，不代表用量为零`
            : `${point.date}：合计 ${fmtInt(point.total)} tokens，` +
              `命中 ${fmtInt(point.hit)}，未命中 ${fmtInt(point.miss)}，输出 ${fmtInt(point.response)}` +
              (point.other > 0 ? `，其他 ${fmtInt(point.other)}` : "");
          // 最近 7 天窗口的末柱恒为今天；给整排日期一个中文锚点，读图不用数格子
          const isToday =
            idx === points.length - 1 && point.date === todayStr();
          const dayLabel = isToday ? "今天" : mmdd(point.date);
          return (
            <div
              className={`${isSummary ? "bar-column" : "detail-bar-column"}${
                active?.date === point.date ? " hovered" : ""
              }`}
              key={point.date}
            >
              {isSummary ? (
                <span className="bar-value">
                  {point.unavailable
                    ? "—"
                    : point.total > 0
                      ? fmtTokensShort(point.total)
                      : "0"}
                </span>
              ) : (
                <span>
                  {point.unavailable
                    ? "—"
                    : point.total > 0
                      ? fmtTokensShort(point.total)
                      : ""}
                </span>
              )}
              <button
                className={isSummary ? "bar-slot" : "detail-bar-slot"}
                type="button"
                aria-label={`${label}。点击或按 Enter 固定明细，Escape 收起`}
                aria-pressed={pinned?.date === point.date}
                onMouseEnter={() => setHoveredDate(point.date)}
                onMouseLeave={() =>
                  setHoveredDate((prev) => (prev === point.date ? null : prev))
                }
                onFocus={() => setFocusedDate(point.date)}
                onBlur={() =>
                  setFocusedDate((prev) => (prev === point.date ? null : prev))
                }
                onClick={() =>
                  setPinnedDate((prev) =>
                    prev === point.date ? null : point.date,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismiss();
                  }
                }}
              >
                <span
                  className={`${isSummary ? "cache-bar" : "detail-bar-stacked"}${point.unavailable ? " unavailable" : ""}`}
                  style={{
                    height: `${point.unavailable ? 18 : point.total > 0 ? Math.max(MIN_BAR, (point.total / maxVal) * 100) : MIN_BAR}%`,
                  }}
                >
                  {point.total > 0 ? (
                    <>
                      {point.hit > 0 && (
                        <i
                          className="seg hit"
                          style={{ flexGrow: point.hit }}
                        />
                      )}
                      {point.miss > 0 && (
                        <i
                          className="seg miss"
                          style={{ flexGrow: point.miss }}
                        />
                      )}
                      {point.response > 0 && (
                        <i
                          className="seg response"
                          style={{ flexGrow: point.response }}
                        />
                      )}
                      {point.other > 0 && (
                        <i
                          className="seg other"
                          style={{ flexGrow: point.other }}
                        />
                      )}
                    </>
                  ) : (
                    <i className="seg empty" />
                  )}
                </span>
              </button>
              {isSummary ? (
                <span className="bar-day">{dayLabel}</span>
              ) : (
                <em>{dayLabel}</em>
              )}
            </div>
          );
        })}
      </div>
      <div className="chart-inspector" aria-live="polite" aria-atomic="true">
        {active ? (
          <>
            <div className="chart-inspector-head">
              <span>
                {mmdd(active.date)}
                {pinned != null ? " · 已固定" : ""}
              </span>
              <strong>
                {active.unavailable
                  ? "数据待取得"
                  : `${fmtTokensShort(active.total)} Tokens`}
              </strong>
            </div>
            {active.unavailable ? (
              <div className="chart-inspector-note">
                尚未取得数据，不代表用量为零
              </div>
            ) : (
              <div
                className={`chart-inspector-values${hasOther ? " four" : ""}`}
              >
                {(
                  [
                    ["hit", "命中", active.hit],
                    ["miss", "未命中", active.miss],
                    ["response", "输出", active.response],
                    ...(hasOther ? [["other", "其他", active.other]] : []),
                  ] as [string, string, number][]
                ).map(([key, title, value]) => (
                  <span key={key} title={`${title}：${fmtInt(value)} Tokens`}>
                    <i className={`dot ${key}`} />
                    {title}{" "}
                    <strong>{fmtTokensShort(value).replace(".0", "")}</strong>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="chart-legend-bottom">
              {[
                ["hit", "命中"],
                ["miss", "未命中"],
                ["response", "输出"],
                ...(hasOther ? [["other", "其他"]] : []),
              ].map(([key, title]) => (
                <span className="chart-legend-item" key={key}>
                  <i className={`dot ${key}`} />
                  {title}
                </span>
              ))}
            </div>
            <div className="chart-inspector-note">
              点选日期固定明细 · Esc 收起
            </div>
          </>
        )}
      </div>
    </>
  );
}
export { StackedBarChart };
