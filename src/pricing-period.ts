/** Pricing rules checked against DeepSeek's pricing page on 2026-10-08.
 * Holiday exclusions use the State Council's published 2026 holiday ranges.
 * They are a calendar interpretation, not evidence of an individual charge.
 */
export type PricingPeriod = "peak" | "offpeak" | "unknown";
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
export const PRICING_RULE_SOURCE =
  "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
export const HOLIDAY_SOURCE =
  "https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html";
const HOLIDAYS: Record<number, readonly (readonly [string, string])[]> = {
  2026: [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
  ],
};

export function pricingPeriodAt(timestamp: number): PricingPeriod {
  if (!Number.isFinite(timestamp)) return "unknown";
  const beijing = new Date(timestamp + BEIJING_OFFSET);
  if (!Number.isFinite(beijing.getTime())) return "unknown";
  const weekday = beijing.getUTCDay();
  // Weekends stay off-peak even when the national calendar calls for make-up work.
  if (weekday === 0 || weekday === 6) return "offpeak";
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const peakWindow =
    (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
  if (!peakWindow) return "offpeak";
  const holidays = HOLIDAYS[beijing.getUTCFullYear()];
  if (!holidays) return "unknown";
  const date = beijing.toISOString().slice(0, 10);
  if (holidays.some(([start, end]) => date >= start && date <= end))
    return "offpeak";
  return "peak";
}

export function nextPricingTransition(timestamp: number) {
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + BEIJING_OFFSET);
  if (!Number.isFinite(shifted.getTime())) return null;
  const start =
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - BEIJING_OFFSET;
  const current = pricingPeriodAt(timestamp);
  // Include midnight to detect a missing calendar year or a weekend becoming known.
  for (let day = 0; day < 16; day++) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const at = start + day * DAY + hour * 60 * 60 * 1000;
      if (at <= timestamp) continue;
      const period = pricingPeriodAt(at);
      if (period !== current) return { at, period };
    }
  }
  return null;
}

export function beijingTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

export function pricingRefreshDelay(timestamp: number): number {
  const next = nextPricingTransition(timestamp);
  return Math.max(1, Math.min(30_000, next ? next.at - timestamp : 30_000));
}
