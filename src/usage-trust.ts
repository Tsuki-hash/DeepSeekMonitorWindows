// 可信状态推导。
//
// 复评 F08：原实现只用 usageState 与 unavailableDates 判断完整性，
// 忽略了 usage.warnings；且普通刷新失败时状态仍是 ok、旧快照照常显示，
// 摘要却宣称「完整」。这里把「完整性」「陈旧」「最后成功」分开计算。

import {
  accountingDateKey,
  chartPointFromDay,
  chartTotalStatus,
  CHART_TOTAL_UNSAFE_REASON,
  missingUsageDates,
  recentUsageDays,
} from "./format.ts";
import type { UsageResult } from "./types";
import { sumUsageCounts, type UsageCountSum } from "./usage-counts.ts";

export const MONTH_SLOT_UNSAFE_REASON =
  "本月模型槽位计数或合计超出安全整数范围，合计未知；已知日期与原始模型保留";
export const MONTH_SLOT_UNKNOWN_REASON =
  "本月模型槽位部分计数未取得或无法汇总；已知日期与原始模型保留";

/** 只检查已返回的月槽位，不要求未使用的槽位存在，也不改写日级/raw 数据。 */
function monthSlotIssue(usage: UsageResult): UsageCountSum["issue"] {
  const countFields = [
    "totalTokens",
    "requestCount",
    "cacheHitTokens",
    "cacheMissTokens",
    "responseTokens",
    "otherTokens",
  ] as const;
  let unknown = false;
  for (const model of usage.models) {
    const checks = [
      ...countFields.map((field) => sumUsageCounts([model[field]])),
      sumUsageCounts([
        model.cacheHitTokens,
        model.cacheMissTokens,
        model.responseTokens,
        model.otherTokens,
      ]),
    ];
    if (checks.some((check) => check.issue === "unsafe")) return "unsafe";
    if (!checks.some((check) => check.issue === "unknown")) continue;
    unknown = true;
    // 后端把跨别名溢出的槽位置 null；可用所属 raw 行辨别溢出与普通缺项。
    // raw 行缺失时不推断零，也不将其他合法槽位的总数相加制造月级溢出。
    const raw = usage.rawModels?.filter((item) =>
      model.key === "other"
        ? item.groupKey !== undefined &&
          item.groupKey !== "flash" &&
          item.groupKey !== "pro"
        : item.groupKey === model.key,
    );
    if (
      raw?.length &&
      countFields.some(
        (field) =>
          sumUsageCounts(raw.map((item) => item[field])).issue === "unsafe",
      )
    )
      return "unsafe";
  }
  return unknown ? "unknown" : null;
}

export type Completeness = "complete" | "partial" | "unknown";

export type UsageTrust = {
  source: string;
  period: string;
  lastSuccess: string | null;
  completeness: Completeness;
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
  if (monthSlotIssue(usage)) return "partial";
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
  // 月初近7日跨两个月；各月/各日安全不代表窗口合计仍在安全整数内。
  if (
    chartTotalStatus(days.slice(-7).map((day) => chartPointFromDay(day)))
      .total == null
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
  const now = input.now ?? new Date();
  // 「有数据但本次失败」：保留旧值，必须标旧。
  const stale = Boolean(usage && (state === "error" || error));
  const completeness = usageCompleteness(usage, Boolean(error), now);
  const reason = (() => {
    if (!usage) return null;
    const days = recentUsageDays(
      usage.days,
      Math.max(7, Number(accountingDateKey(now).slice(8))),
      usage.unavailableDates,
      now,
      usage.accountingDate,
    );
    const points = days.map((day) => chartPointFromDay(day));
    const unsafeDay = points.find((point) => point.countIssue === "unsafe");
    if (unsafeDay) return `${unsafeDay.date}：${unsafeDay.unavailableReason}`;
    if (chartTotalStatus(points.slice(-7)).issue === "unsafe")
      return CHART_TOTAL_UNSAFE_REASON;
    const monthIssue = monthSlotIssue(usage);
    if (monthIssue === "unsafe") return MONTH_SLOT_UNSAFE_REASON;
    if (monthIssue === "unknown") return MONTH_SLOT_UNKNOWN_REASON;
    if (usage.warnings?.length) return usage.warnings[0];
    if (usage.unavailableDates?.length) {
      return `${usage.unavailableDates.length} 个日期未取得，不代表零用量`;
    }
    if (usage.monthCost == null) return "本月费用未取得";
    const missing = missingUsageDates(usage, now);
    if (missing.length) return `${missing.length} 个日期未取得，不代表零用量`;
    if (completeness === "partial") return "部分日期的用量或费用未取得";
    return null;
  })();
  return {
    source: "平台用量",
    period: `${snapshotMonth ?? currentMonth} · 北京时间`,
    lastSuccess: lastSuccessText,
    completeness,
    stale,
    reason,
  };
}
