import React from "react";
import { mmdd } from "../format";

type Day = { date: string; value: number | null };
type ViewportBar = { date: string; left: number; width: number };
type MonthViewport = {
  left: number;
  width: number;
  scrollWidth: number;
  bars: ViewportBar[];
};
// 浏览器提交后、绘制前保持阅读位置；无 DOM 的渲染环境不访问全局 document。
const useViewportLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;
const rightEdge = (viewport: MonthViewport) =>
  Math.max(0, viewport.scrollWidth - viewport.width);
const isVisible = (bar: ViewportBar, viewport: MonthViewport) =>
  bar.left + bar.width > viewport.left &&
  bar.left < viewport.left + viewport.width;

function readViewport(
  element: HTMLDivElement,
  days: Day[],
  buttons: Map<string, HTMLButtonElement>,
): MonthViewport | null {
  if (
    !Number.isFinite(element.clientWidth) ||
    element.clientWidth <= 0 ||
    !Number.isFinite(element.scrollWidth) ||
    !Number.isFinite(element.scrollLeft) ||
    typeof element.getBoundingClientRect !== "function"
  )
    return null;
  const origin = element.getBoundingClientRect().left + element.clientLeft;
  if (!Number.isFinite(origin)) return null;
  const bars = days.flatMap(({ date }) => {
    const button = buttons.get(date);
    if (typeof button?.getBoundingClientRect !== "function") return [];
    const rect = button.getBoundingClientRect();
    return Number.isFinite(rect.left) &&
      Number.isFinite(rect.width) &&
      rect.width > 0
      ? [
          {
            date,
            left: rect.left - origin + element.scrollLeft,
            width: rect.width,
          },
        ]
      : [];
  });
  return bars.length
    ? {
        left: element.scrollLeft,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        bars,
      }
    : null;
}

function restoreViewport(
  element: HTMLDivElement,
  current: MonthViewport,
  snapshot: MonthViewport | null,
  pinnedDate: string | null,
  buttons: Map<string, HTMLButtonElement>,
) {
  const focusedDate = current.bars.find(
    ({ date }) => buttons.get(date) === element.ownerDocument?.activeElement,
  )?.date;
  // Escape 收起明细后，实际焦点仍可能在旧柱上；渲染 ref / focus 请求都不算焦点。
  const protectedDates = [pinnedDate, focusedDate].filter(
    (date): date is string =>
      date != null && current.bars.some((bar) => bar.date === date),
  );
  // 原生横滚／焦点滚动可先于 scroll 事件，也可紧挨着新快照提交。
  // 排除新布局自然夹紧旧位置的情况后，先尊重这个尚未记录的阅读位置。
  const previous =
    snapshot &&
    Math.abs(current.left - Math.min(snapshot.left, rightEdge(current))) > 0.5
      ? { ...snapshot, left: current.left }
      : snapshot;
  let left = previous?.left ?? rightEdge(current);
  if (previous) {
    if (
      Math.abs(rightEdge(previous) - previous.left) <= 1 &&
      protectedDates.length === 0
    ) {
      left = rightEdge(current);
    } else {
      // 优先保留首个可见日期的像素位置，而非旧 scrollLeft；左侧补月不会换读到的内容。
      const retained = previous.bars.filter((old) =>
        current.bars.some((bar) => bar.date === old.date),
      );
      const anchor =
        retained.find((bar) => isVisible(bar, previous)) ?? retained[0];
      const moved = current.bars.find((bar) => bar.date === anchor?.date);
      if (anchor && moved) left = previous.left + moved.left - anchor.left;
      // 只修正缩窄／柱宽变化新增的遮挡；纯 append / prepend 不能把用户主动
      // 留在边缘的部分可见柱拉回。两者放不下时真实焦点优先，不调用 focus。
      let visibilityCorrected = false;
      for (const date of protectedDates) {
        const old = previous.bars.find((bar) => bar.date === date);
        const bar = current.bars.find((bar) => bar.date === date);
        if (
          !old ||
          !bar ||
          !isVisible(old, previous) ||
          (current.width >= previous.width &&
            Math.abs(bar.width - old.width) <= 0.5 &&
            !visibilityCorrected)
        )
          continue;
        // 在日期锚点恢复后比较每一侧的裁切量，不把既有裁切误判为新增遮挡。
        const oldLeftClip = Math.max(0, previous.left - old.left);
        const oldRightClip = Math.max(
          0,
          old.left + old.width - previous.left - previous.width,
        );
        const leftClip = Math.max(0, left - bar.left);
        const rightClip = Math.max(
          0,
          bar.left + bar.width - left - current.width,
        );
        // 柱自身缩短也可能吃掉原先仅剩的可见像素，即使左裁切量没有增加。
        const becameHidden =
          bar.left + bar.width <= left || bar.left >= left + current.width;
        if (
          leftClip > oldLeftClip + 0.5 ||
          rightClip > oldRightClip + 0.5 ||
          becameHidden
        ) {
          left = Math.max(left, bar.left + bar.width - current.width);
          left = Math.min(left, bar.left);
          // 固定柱变宽后的修正若遮挡真实焦点，后者仍有最后决定权。
          visibilityCorrected = true;
        }
      }
    }
  }
  left = Math.max(0, Math.min(rightEdge(current), left));
  if (Math.abs(element.scrollLeft - left) > 0.5) element.scrollLeft = left;
}

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
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const viewport = React.useRef<MonthViewport | null>(null);
  const syncViewport = React.useRef<() => void>(() => {});
  useViewportLayoutEffect(() => {
    // 每次提交才更新闭包，放弃的并发 render 不改变已提交的滚动策略。
    syncViewport.current = () => {
      const element = chart.current;
      if (!monthly || days.length === 0) {
        viewport.current = null;
        return;
      }
      if (!element) return;
      const current = readViewport(element, days, buttons.current);
      if (!current) return; // 隐藏／零宽／非 DOM 环境，等下一次有效布局。
      const previous = viewport.current;
      const layoutChanged =
        !previous ||
        current.width !== previous.width ||
        current.scrollWidth !== previous.scrollWidth ||
        current.bars.length !== previous.bars.length ||
        current.bars.some((bar, index) => {
          const old = previous.bars[index];
          return (
            old.date !== bar.date ||
            Math.abs(old.left - bar.left) > 0.5 ||
            Math.abs(old.width - bar.width) > 0.5
          );
        });
      // 单纯 focus / hover / pin 提交不能撤销浏览器刚完成的键盘滚入视野。
      if (layoutChanged)
        restoreViewport(
          element,
          current,
          previous,
          pinnedDate,
          buttons.current,
        );
      viewport.current = readViewport(element, days, buttons.current);
    };
    syncViewport.current();
  });
  React.useEffect(() => {
    const element = chart.current;
    if (!monthly || !element) return;
    const sync = () => syncViewport.current();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      observer.observe(element);
      for (const button of buttons.current.values()) observer.observe(button);
      return () => observer.disconnect();
    }
    const view = element.ownerDocument?.defaultView;
    view?.addEventListener("resize", sync);
    return () => view?.removeEventListener("resize", sync);
  }, [monthly, days]);
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
        onScroll={() => {
          if (monthly && days.length && chart.current) {
            const current = readViewport(chart.current, days, buttons.current);
            if (current) viewport.current = current;
          }
        }}
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
