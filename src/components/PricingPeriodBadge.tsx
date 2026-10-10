import React from "react";
import { listen } from "@tauri-apps/api/event";
import {
  beijingTime,
  nextPricingTransition,
  pricingPeriodAt,
  pricingRefreshDelay,
} from "../pricing-period";

function PricingPeriodBadge() {
  const [now, setNow] = React.useState(Date.now);
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const id = React.useId();
  React.useEffect(() => {
    let disposed = false;
    let timer = 0;
    const refresh = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      const timestamp = Date.now();
      setNow(timestamp);
      timer = window.setTimeout(refresh, pricingRefreshDelay(timestamp));
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    const shown = listen("main-window-shown", refresh).catch(() => undefined);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      void shown.then((unlisten) => unlisten?.());
    };
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const period = pricingPeriodAt(now);
  const label = period === "peak" ? "峰" : period === "offpeak" ? "谷" : "—";
  const meaning =
    period === "peak"
      ? "高峰时段"
      : period === "offpeak"
        ? "空闲时段 · 半价"
        : "时段待核对 · 节假日日历未覆盖当前年份";
  const next = nextPricingTransition(now);
  const nextText = next
    ? `${beijingTime(next.at)} ${next.period === "unknown" ? "节假日日历待更新" : `切换为${next.period === "peak" ? "峰" : "谷"}时段`}`
    : "暂无已知切换时间";

  return (
    <div className="pricing-period-wrap" ref={root}>
      <button
        ref={button}
        type="button"
        className={`pricing-period-badge ${period}`}
        aria-label={`当前${meaning}，查看峰谷规则`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`${meaning}（北京时间）\n${nextText}`}
        onClick={() => {
          setNow(Date.now());
          setOpen((value) => !value);
        }}
      >
        {label}
      </button>
      {open && (
        <div
          id={id}
          className="pricing-period-popover"
          role="region"
          aria-label="峰谷计价说明"
        >
          <strong>{meaning}</strong>
          <span>北京时间 {beijingTime(now)}</span>
          <span>{nextText}</span>
          <p>
            周一至周五 09:00–12:00、14:00–18:00
            为峰，其余为谷，谷价为峰价的一半。
          </p>
          <p>
            周末全天为谷，包括调休上班日。节假日按国务院2026年整段放假安排排除高峰。
          </p>
          <small>
            依据 DeepSeek
            官网规则（2026-10-08核对）；节假日采用放假日历解释，实际扣费以平台账单为准。
          </small>
        </div>
      )}
    </div>
  );
}
export { PricingPeriodBadge };
