// 可信状态推导。
//
// 复评 F08：原实现只用 usageState 与 unavailableDates 判断完整性，
// 忽略了 usage.warnings；且普通刷新失败时状态仍是 ok、旧快照照常显示，
// 摘要却宣称「完整」。这里把「完整性」「陈旧」「最后成功」分开计算。

import {
  accountingDateKey,
  chartPointFromDay,
  missingUsageDates,
  recentUsageDays,
} from "./format.ts";
import type { UsageResult } from "./types";

export type Completeness = "complete" | "partial" | "unknown";

export type UsageTrust = {
  source: string;
  period: string;
  lastSuccess: string | null;
  completeness: Completeness;
  accountVerified: boolean;
  stale: boolean;
  /** 给用户的补充说明：为什么不是完整。 */
  reason: string | null;
};

export function usageCompleteness(
  usage: UsageResult | null,
  hasError: boolean,
  now: Date = new Date(),
): Completeness {
  if (!usage) return "unknown";
  // 有质量警告或缺失日期时，即使本次请求成功也只是「部分」。
  if (usage.warnings?.length) return "partial";
  if (usage.unavailableDates?.length) return "partial";
  if (usage.monthCost == null) return "partial";
  if (missingUsageDates(usage, now).length) return "partial";
  const days = recentUsageDays(
    usage.days,
    Math.max(7, Number(accountingDateKey(now).slice(8))),
    usage.unavailableDates,
    now,
    usage.accountingDate,
  );
  if (
    days.some(
      (day) => day.totalCost == null || chartPointFromDay(day).unavailable,
    )
  )
    return "partial";
  // 本次请求失败：数据是否完整无从判断（旧快照可能已经不完整）。
  if (hasError) return "unknown";
  return "complete";
}

export function usageTrust(input: {
  usage: UsageResult | null;
  state: "loading" | "ok" | "error" | "nokey";
  error: string;
  updatedAt: number | null;
  /** 快照所属记账月，用于判断是否跨月。 */
  snapshotMonth: string | null;
  currentMonth: string;
  /** 最后成功时间格式化后的文本。 */
  lastSuccessText: string | null;
  now?: Date;
}): UsageTrust {
  const { usage, state, error, snapshotMonth, currentMonth, lastSuccessText } =
    input;
  // 「有数据但本次失败」：保留旧值，必须标旧。
  const stale = Boolean(usage && (state === "error" || error));
  const completeness = usageCompleteness(usage, Boolean(error), input.now);
  const reason = (() => {
    if (!usage) return null;
    if (usage.warnings?.length) return usage.warnings[0];
    if (usage.unavailableDates?.length) {
      return `${usage.unavailableDates.length} 个日期未取得，不代表零用量`;
    }
    if (usage.monthCost == null) return "本月费用未取得";
    const missing = missingUsageDates(usage, input.now);
    if (missing.length) return `${missing.length} 个日期未取得，不代表零用量`;
    if (completeness === "partial") return "部分日期的用量或费用未取得";
    return null;
  })();
  return {
    source: "平台用量",
    period: `${snapshotMonth ?? currentMonth} · 北京时间`,
    lastSuccess: lastSuccessText,
    completeness,
    // 余额 Key 与用量 Token 未做账户匹配，始终如实标「未核对」。
    accountVerified: false,
    stale,
    reason,
  };
}
