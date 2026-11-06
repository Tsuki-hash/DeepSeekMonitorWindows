import { missingUsageDates } from "./format.ts";
import type { UsageResult } from "./types";

export function usageNotices(
  usage: UsageResult | null,
  now: Date = new Date(),
): string[] {
  const notices = [...(usage?.warnings ?? [])];
  if (
    usage &&
    (usage.unavailableDates?.length || missingUsageDates(usage, now).length)
  ) {
    notices.push("部分日期暂未取得数据，图中以 — 标记；不代表当天用量为零。");
  }
  return [...new Set(notices.filter(Boolean))];
}
