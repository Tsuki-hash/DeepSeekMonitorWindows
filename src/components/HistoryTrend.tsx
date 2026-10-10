import React from "react";
import { mmdd } from "../format";

type Day = { date: string; value: number | null };
export function HistoryTrend({
  days,
  metric,
  monthly = false,
}: {
  monthly?: boolean;
  days: Day[];
  metric: "totalTokens" | "cost";
}) {
  const [active, setActive] = React.useState<string | null>(null);
  const [pinned, setPinned] = React.useState<string | null>(null);
  const chart = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (monthly && chart.current)
      chart.current.scrollLeft = chart.current.scrollWidth;
  }, [monthly, days.length]);
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selected = days.find((day) => day.date === (active ?? pinned));
  const label = (day: Day) => (monthly ? day.date.slice(0, 7) : day.date);
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
            {pinned === selected.date && (
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
        onMouseLeave={() => setActive(null)}
      >
        {days.map((day, index) => (
          <button
            key={day.date}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            className={`${day.value == null ? "missing" : ""} ${selected?.date === day.date ? "active" : ""}`}
            aria-label={`${label(day)}：${value(day)}`}
            aria-pressed={pinned === day.date}
            onMouseEnter={() => setActive(day.date)}
            onFocus={() => setActive(day.date)}
            onBlur={() => setActive(null)}
            onClick={() => {
              setPinned((current) => (current === day.date ? null : day.date));
              setActive(day.date);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPinned(null);
                setActive(null);
              }
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                buttons.current[
                  Math.max(
                    0,
                    Math.min(
                      days.length - 1,
                      index + (event.key === "ArrowRight" ? 1 : -1),
                    ),
                  )
                ]?.focus();
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
        <span>{days[0] ? mmdd(days[0].date) : ""}</span>
        <span>
          {days[days.length - 1] ? mmdd(days[days.length - 1]!.date) : ""}
        </span>
      </div>
    </>
  );
}
