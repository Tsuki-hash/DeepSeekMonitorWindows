import React from "react";
import { mmdd } from "../format";

type Day = { date: string; value: number | null };
export function HistoryTrend({
  days,
  metric,
  monthly = false,
  dateLabel = (date: string) => (monthly ? date.slice(0, 7) : mmdd(date)),
}: {
  monthly?: boolean;
  days: Day[];
  metric: "totalTokens" | "cost";
  /** 日期显示口径；跨年范围由调用方切成完整日期，避免不同年份显示成同一天。 */
  dateLabel?: (date: string) => string;
}) {
  const [hoveredDate, setHoveredDate] = React.useState<string | null>(null);
  const [focusedDate, setFocusedDate] = React.useState<string | null>(null);
  const [pinnedDate, setPinnedDate] = React.useState<string | null>(null);
  // 与七日图一致：固定 > 聚焦 > 悬停。鼠标不能覆盖仍在柱上的键盘焦点。
  // 渲染时先过滤失效日期，刷新/位移不能把另一根柱子冒充为原来的日期。
  const pinned = days.find((day) => day.date === pinnedDate);
  const focused = days.find((day) => day.date === focusedDate);
  const hovered = days.find((day) => day.date === hoveredDate);
  const selected = pinned ?? focused ?? hovered;
  React.useEffect(() => {
    const dates = new Set(days.map((day) => day.date));
    const retainVisible = (date: string | null) =>
      date != null && dates.has(date) ? date : null;
    // 日期移出后清理身份；同一日期再次进入时不能复活旧固定/预览状态。
    setHoveredDate(retainVisible);
    setFocusedDate(retainVisible);
    setPinnedDate(retainVisible);
  }, [days]);
  const chart = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (monthly && chart.current)
      chart.current.scrollLeft = chart.current.scrollWidth;
  }, [monthly, days.length]);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const label = (day: Day) => dateLabel(day.date);
  const maximum = Math.max(...days.map((day) => day.value ?? 0), 1);
  const value = (day: Day) =>
    day.value == null
      ? "未取得（不代表零）"
      : metric === "cost"
        ? `¥${day.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
        : `${day.value.toLocaleString("zh-CN")} Tokens`;
  return (
    <>
      <div
        className="history-trend-reading"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {selected ? (
          <>
            <span>{label(selected)}</span>
            <strong>{value(selected)}</strong>
            {pinned?.date === selected.date && (
              <span className="history-trend-pin">已固定</span>
            )}
          </>
        ) : (
          <span>悬停或点击查看数据</span>
        )}
      </div>
      <div
        className={`history-bars ${metric} ${monthly ? "monthly" : ""}`}
        ref={chart}
        role="group"
        aria-label={monthly ? "每月趋势数据" : "每日趋势数据"}
        onMouseLeave={() => setHoveredDate(null)}
      >
        {days.map((day, index) => (
          <button
            key={day.date}
            ref={(node) => {
              if (node) buttons.current.set(day.date, node);
              else buttons.current.delete(day.date);
            }}
            type="button"
            className={`${day.value == null ? "missing" : ""} ${selected?.date === day.date ? "active" : ""}`}
            aria-label={`${label(day)}：${value(day)}`}
            aria-pressed={pinned?.date === day.date}
            onMouseEnter={() => setHoveredDate(day.date)}
            onMouseLeave={() =>
              setHoveredDate((current) =>
                current === day.date ? null : current,
              )
            }
            onFocus={() => setFocusedDate(day.date)}
            onBlur={() =>
              setFocusedDate((current) =>
                current === day.date ? null : current,
              )
            }
            onClick={() =>
              setPinnedDate((current) =>
                current === day.date ? null : day.date,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPinnedDate(null);
                setFocusedDate(null);
                setHoveredDate(null);
                // 仅收起明细，不 blur/focus；实际焦点留在原日期按钮上。
              }
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const target =
                  days[
                    Math.max(
                      0,
                      Math.min(
                        days.length - 1,
                        index + (event.key === "ArrowRight" ? 1 : -1),
                      ),
                    )
                  ];
                // 由真实 onFocus 更新聚焦身份；不能先显示尚未取得焦点的日期。
                if (target) buttons.current.get(target.date)?.focus();
              }
            }}
          >
            <i
              aria-hidden="true"
              style={{
                height:
                  day.value == null
                    ? 2
                    : Math.max(2, (day.value / maximum) * 76),
              }}
            />
          </button>
        ))}
      </div>
      <div className="history-axis">
        <span>{days[0] ? label(days[0]) : ""}</span>
        <span>
          {days[days.length - 1] ? label(days[days.length - 1]!) : ""}
        </span>
      </div>
    </>
  );
}
