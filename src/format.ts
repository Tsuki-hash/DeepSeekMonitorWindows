// 纯格式化 / 日期工具。
//
// 这些函数原先散在 main.tsx 里，与 React 组件混在一起，导致无法单独测。
// 抽出来之后可以用 Node 内置的 `node --test`（配合 --experimental-strip-types 直接读 .ts）
// 跑最小单测，不需要引入 vitest / jest 这类会拉进几十个 devDependency 的测试框架。
//
// 注意本文件**不得** import 任何浏览器或 Tauri API，否则 Node 侧测不了。

import { sumUsageCounts, type UsageCountSum } from "./usage-counts.ts";

// 日级计数与费用：`null` 表示「未取得」，不是零。图表据此区分空柱与未知柱。
export type UsageDay = {
  rawModels?: import("./types").RawModelUsage[];
  unavailable?: boolean;
  date: string;
  flashTokens: number | null;
  flashCacheHit: number | null;
  flashCacheMiss: number | null;
  flashResponse: number | null;
  proTokens: number | null;
  proCacheHit: number | null;
  proCacheMiss: number | null;
  proResponse: number | null;
  flashOtherTokens: number | null;
  proOtherTokens: number | null;
  totalTokens: number | null;
  totalCost: number | null;
};

/** 千分位整数。用于 tooltip 里的精确 token 数。 */
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * 紧凑 token 数：柱顶标签用，必须在 ~34px 宽度内放得下。
 *
 * 三个阈值都按「换算后不再进位」来切，否则会出现 `999999 → "1000.0K"` 这种
 * 比 M 档还长的字符串（7 字符），正是柱顶标签被裁掉的直接原因。
 * 因此 K 档上界取到 999_499（四舍五入后仍为 999.5K），超过就升到 M 档。
 */
export const fmtTokensShort = (n: number) => {
  if (n >= 999_950_000_000) return (n / 1e12).toFixed(1) + "T";
  if (n >= 999_950_000) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e8) return (n / 1e6).toFixed(0) + "M";
  if (n >= 999_500) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};

/** 紧凑卡片的大额展示；完整金额保留在 title 与无障碍标签。 */
export const fmtMoneyDisplay = (n: number, symbol = "¥") => {
  if (n >= 1e4) return symbol + fmtTokensShort(n);
  return fmtMoney(n, symbol);
};

export const fmtMoney = (n: number, symbol = "¥") => symbol + n.toFixed(2);

/**
 * 币种符号的唯一来源。余额来自官方接口、带 currency 字段（正常为 CNY，也存在 USD 账户）；
 * 而用量与消费来自平台内部接口，恒为人民币计价。两者口径不同，所以共享同一面板时必须
 * 用余额的币种符号，否则会出现「余额 $xx 而当日消耗 ¥xx」的矛盾显示。
 */
export const currencySymbol = (currency?: string) =>
  currency === "USD" ? "$" : "¥";

/** `2026-09-11` → `9/11`。 */
export const mmdd = (date: string) => {
  const parts = date.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date;
};

/** 平台东八区记账日期，与接口返回的 date 一致。 */
export const accountingDateKey = (date: Date) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export const todayStr = () => accountingDateKey(new Date());

/** Date → `YYYY-MM-DD`（本地时区，不走 toISOString 以免被 UTC 偏移带偏一天）。 */
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

export const addDays = (date: Date, offset: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
};

/** 空的一天。用于把接口没返回的日期标成未知，保证柱状图始终 7 根。 */
export const emptyUsageDay = (date: string): UsageDay => ({
  date,
  unavailable: true,
  rawModels: [],
  flashTokens: null,
  flashCacheHit: null,
  flashCacheMiss: null,
  flashResponse: null,
  proTokens: null,
  proCacheHit: null,
  proCacheMiss: null,
  proResponse: null,
  flashOtherTokens: null,
  proOtherTokens: null,
  totalTokens: null,
  totalCost: null,
});

/** 与历史导出一致：空 data / 缺少原始模型行不构成已返回日期。 */
export const hasReturnedUsageDay = (
  day: UsageDay,
  unavailableDates: string[] = [],
  sourceAsOfDate?: string,
): boolean =>
  !day.unavailable &&
  !unavailableDates.includes(day.date) &&
  (!sourceAsOfDate || day.date <= sourceAsOfDate) &&
  Boolean(day.rawModels?.length);

/**
 * 取最近 `count` 天（含今天）的用量，接口没给的日期补为未知。
 *
 * 两个刻意的取舍：
 * 1. 过滤掉 `date > today` 的条目——接口在月初可能返回整月（含未来日期）的占位行，
 *    不过滤会让活跃度柱状图出现「未来几天有数据」的怪象；
 * 2. 按**东八区记账日期**逐天递减生成，而不是拿接口返回的最后一天往前数——跨月时
 *    上个月的日期必须能被正确补进窗口，否则月初打开面板会看到几根空柱。
 *
 * 第五轮复评 N07：`now` 可注入（默认真实时钟）。测试必须传固定时刻并以
 * 记账日（UTC+8）定义期望，否则断言混用宿主本地日会在跨时区环境假红。
 */
export const recentUsageDays = (
  days: UsageDay[],
  count = 7,
  unavailableDates: string[] = [],
  now: Date = new Date(),
  sourceAsOfDate?: string,
): UsageDay[] => {
  const today = accountingDateKey(now);
  const source = new Map(
    days
      .filter(
        (day) =>
          day.date <= today && (!sourceAsOfDate || day.date <= sourceAsOfDate),
      )
      .map((day) => [day.date, day]),
  );
  const anchor = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(anchor.getTime() + (index - count + 1) * 86400_000)
      .toISOString()
      .slice(0, 10);
    const day = source.get(date);
    return day && hasReturnedUsageDay(day, unavailableDates, sourceAsOfDate)
      ? day
      : emptyUsageDay(date);
  });
};

/** 上一个月，给「查看上月用量」用。跨年时 year 一并回退。 */
export const previousMonth = (date: Date) => {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return { month: previous.getMonth() + 1, year: previous.getFullYear() };
};

/** 刷新失败后的展示态：silent 且已有数据时保留「ok」，便于界面保留快照。 */
export const nextLoadStateAfterError = (
  prev: "loading" | "ok" | "error" | "nokey",
  silent: boolean,
  message: string,
  code?: string,
): "loading" | "ok" | "error" | "nokey" => {
  if (silent && prev === "ok") {
    return "ok";
  }
  return (code ? code === "not_configured" : message.includes("未配置"))
    ? "nokey"
    : "error";
};

export type ChartScope = "all" | "flash" | "pro" | "other";

export type ChartPoint = {
  unavailable?: boolean;
  /** 已返回的计数问题不等于日期缺失。 */
  unavailableReason?: string;
  countIssue?: UsageCountSum["issue"];
  date: string;
  hit: number | null;
  miss: number | null;
  response: number | null;
  other: number | null;
  total: number | null;
};

export const CHART_TOTAL_UNSAFE_REASON =
  "近7日 Token 计数或合计超出安全整数范围，合计未知；已知日期与分段保留";

/**
 * 把单日用量映射成柱状图数据点。
 *
 * `scope === "all"` 时合计优先取 `day.totalTokens`（后端覆盖含未识别模型），
 * 未识别 rawModels 的安全总量先独立并入 other，保留缺段时已知的新模型用量；
 * 仅完整安全分段才能把总量的剩余差额并入 other，且不能重复累加 rawModels。
 * 单模型（flash/pro）按分段求和，但不能绕过后端槽位总量的未知状态。
 * `scope === "other"` 是未接入模型的兜底档：平台不给分段明细，
 * 按日量 = 当日合计 − flash − pro，柱子只有一段。
 *
 * 任一参与计算的字段为 `null` 时返回 `unavailable: true`：接口缺项与真实零用量
 * 在图上必须是两种不同的显示。
 */
export const chartPointFromDay = (
  day: UsageDay,
  scope: ChartScope = "all",
): ChartPoint => {
  const unknown: ChartPoint = {
    unavailable: true,
    date: day.date,
    hit: null,
    miss: null,
    response: null,
    other: null,
    total: null,
  };
  if (!hasReturnedUsageDay(day)) return unknown;
  // 非空原始行及后端槽位的未知/超界不能被分段和或旧版聚合零掩盖。
  // 单槽位仅检查所属模型，不能让异常 Flash 污染合法 Pro（反之亦然）。
  const rawTotal = sumUsageCounts(
    day
      .rawModels!.filter(
        (model) =>
          scope === "all" || scope === "other" || model.groupKey === scope,
      )
      .map((model) => model.totalTokens),
  );
  const slotTotals = (
    scope === "flash"
      ? [day.flashTokens]
      : scope === "pro"
        ? [day.proTokens]
        : [day.totalTokens, day.flashTokens, day.proTokens]
  ).map((value) => sumUsageCounts([value]));
  const hit = sumUsageCounts(
    scope === "flash"
      ? [day.flashCacheHit]
      : scope === "pro"
        ? [day.proCacheHit]
        : scope === "all"
          ? [day.flashCacheHit, day.proCacheHit]
          : [],
  );
  const miss = sumUsageCounts(
    scope === "flash"
      ? [day.flashCacheMiss]
      : scope === "pro"
        ? [day.proCacheMiss]
        : scope === "all"
          ? [day.flashCacheMiss, day.proCacheMiss]
          : [],
  );
  const response = sumUsageCounts(
    scope === "flash"
      ? [day.flashResponse]
      : scope === "pro"
        ? [day.proResponse]
        : scope === "all"
          ? [day.flashResponse, day.proResponse]
          : [],
  );
  const knownSlots = sumUsageCounts([day.flashTokens, day.proTokens]);
  const unknownModels = day.rawModels!.filter(
    (model) => model.groupKey !== "flash" && model.groupKey !== "pro",
  );
  // null 是后端明确的「未识别模型」组；缺 groupKey 的旧形状没有归属依据，
  // 不能把整行当作新增 other（它也可能已计入 Flash/Pro），更不能当作零。
  const rawOther = sumUsageCounts(
    unknownModels.map((model) =>
      model.groupKey === undefined ? null : model.totalTokens,
    ),
  );
  const knownOther =
    scope === "flash"
      ? sumUsageCounts([day.flashOtherTokens])
      : scope === "pro"
        ? sumUsageCounts([day.proOtherTokens])
        : scope === "all"
          ? sumUsageCounts([
              day.flashOtherTokens,
              day.proOtherTokens,
              rawOther.total,
            ])
          : knownSlots.total == null || slotTotals[0].total == null
            ? { total: null, issue: knownSlots.issue ?? slotTotals[0].issue }
            : sumUsageCounts([
                Math.max(0, slotTotals[0].total - knownSlots.total),
              ]);
  // 旧聚合可能有未归属差额，却没有对应的 raw 模型行。缺段时无法使用
  // 「日总量 − 全部分段」辨认来源，不得把空 raw 筛选误当成确定的 other=0。
  // 只有安全日总量明确多出一部分才算差额证据，total=null 不能清掉已知 other。
  // 完整安全分段仍由下方的剩余差额兼容路径处理。
  if (
    scope === "all" &&
    unknownModels.length === 0 &&
    [hit, miss, response].some((segment) => segment.total == null) &&
    slotTotals[0].total != null &&
    ((knownSlots.total != null && slotTotals[0].total > knownSlots.total) ||
      (rawTotal.total != null && slotTotals[0].total > rawTotal.total))
  ) {
    knownOther.total = null;
    knownOther.issue ??= "unknown";
  }
  const segmented = sumUsageCounts([
    hit.total,
    miss.total,
    response.total,
    knownOther.total,
  ]);
  const checks = [
    rawTotal,
    ...slotTotals,
    ...(scope === "all" || scope === "other" ? [knownSlots] : []),
    ...(scope === "all" ? [rawOther] : []),
    hit,
    miss,
    response,
    knownOther,
    segmented,
  ];
  const issue = checks.some((check) => check.issue === "unsafe")
    ? "unsafe"
    : checks.some((check) => check.total == null)
      ? "unknown"
      : null;
  const segments = {
    hit: hit.total,
    miss: miss.total,
    response: response.total,
    other: knownOther.total,
  };
  if (issue || segmented.total == null) {
    return {
      ...unknown,
      ...segments,
      countIssue: issue,
      unavailableReason:
        issue === "unsafe"
          ? "Token 计数或合计超出安全整数范围，合计未知；已知分段保留"
          : "部分 Token 计数未取得或无法汇总，合计未知；已知分段保留",
    };
  }
  const total =
    scope === "all"
      ? Math.max(slotTotals[0].total!, segmented.total)
      : segmented.total;
  // total 与分段和均已安全且非负，差额仍必须走同一累加器。
  const other = sumUsageCounts([
    knownOther.total,
    total - segmented.total,
  ]).total;
  return {
    date: day.date,
    ...segments,
    other,
    total,
    unavailable: day.unavailable,
  };
};

/** 近 N 日逐项安全累加；未知/超界不能被后续真实零重新变成有效合计。 */
export function chartTotalStatus(points: ChartPoint[]): UsageCountSum {
  const sum = sumUsageCounts(points.map((point) => point.total));
  if (
    sum.issue === "unsafe" ||
    points.some((point) => point.countIssue === "unsafe")
  )
    return { total: null, issue: "unsafe" };
  if (points.some((point) => point.unavailable))
    return { total: null, issue: "unknown" };
  return sum;
}

export const chartTotal = (points: ChartPoint[]): number | null =>
  chartTotalStatus(points).total;

/** 当前月及近7日的源日期覆盖，统一用于状态与图表提示。 */
export function missingUsageDates(
  usage: import("./types").UsageResult,
  now: Date = new Date(),
): string[] {
  const today = accountingDateKey(now);
  const count = Math.max(7, Number(today.slice(8)));
  return recentUsageDays(
    usage.days,
    count,
    usage.unavailableDates,
    now,
    usage.accountingDate,
  )
    .filter((day) => !hasReturnedUsageDay(day))
    .map((day) => day.date);
}
