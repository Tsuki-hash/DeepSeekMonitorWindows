import { hasReturnedUsageDay } from "./format.ts";
import type { RawModelUsage, UsageResult } from "./types";
export type HistoryRange = "month" | "previous" | "30days" | "custom" | "all";
export type HistoryWindow = { from: string; to: string; months: string[] };
export type HistoryMonth = {
  month: string;
  fetchedAt: number;
  /**
   * 复评 T10：**请求发起时**的东八区记账日。
   *
   * 旧实现只用 5 分钟 TTL 复用本月 payload，跨记账午夜后仍把同一份响应当
   * 本日数据：接口在月初会返回未来日期的零占位行，跨过午夜后这些「未来」
   * 日期就变成了「今天」，于是凭空多出一根「今天 0 Tokens」的实测柱。
   * 用发起时刻的记账日作为窗口上界，晚于它的行一律不算「已返回」。
   * 旧夹具/调用方可省略（空串表示「未记录」，此时不做该过滤）。
   */
  sourceAsOfDate?: string;
  usage: UsageResult;
};
export type HistoryRecord = { date: string; model: RawModelUsage };
/** Source evidence only. These records never enter returned rows or coverage. */
export type HistoryExcludedDay = {
  month: string;
  date: string;
  reason: "invalid-date" | "outside-query-month";
  message: string;
  fetchedAt: number;
  sourceAsOfDate: string | null;
  accountingDate: string | null;
  unavailable: boolean;
  models: RawModelUsage[];
  warnings: string[];
};
/** Coverage exists even when every attempted month failed and no data returned. */
export type HistorySnapshot = {
  window: HistoryWindow;
  months: HistoryMonth[];
  rows: HistoryRecord[];
  /** Invalid or wrong-month source dates, kept apart from normal daily records. */
  excludedDays: HistoryExcludedDay[];
  missingDates: string[];
  /** 已查询但失败的月份，可与保留的旧成功快照重叠，不能视作恢复。 */
  failedMonths: string[];
  /** 尚无已提交查询结果的月份：包括更早批次、在途和跨月空洞，不算「未返回」。 */
  unloadedMonths: string[];
};

/** Exact Gregorian YYYY-MM-DD only; never normalize an invalid source date. */
export function isHistoryDate(date: string): boolean {
  if (date.length !== 10) return false;
  const parts = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(date);
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

export function historyWindow(
  range: HistoryRange,
  today: string,
  selectedMonth = today.slice(0, 7),
): HistoryWindow {
  if (!isHistoryDate(today)) throw new Error("无效历史区间");
  const date = new Date(`${today}T00:00:00Z`);
  let from: string;
  let to = today;
  if (range === "all") {
    from = "2020-01-01";
  } else if (range === "custom") {
    if (
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(selectedMonth) ||
      selectedMonth < "2020-01" ||
      selectedMonth > today.slice(0, 7)
    )
      throw new Error("请选择有效历史月份");
    from = `${selectedMonth}-01`;
    const [year, month] = selectedMonth.split("-").map(Number);
    to =
      selectedMonth === today.slice(0, 7)
        ? today
        : new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  } else if (range === "30days") {
    from = new Date(date.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  } else if (range === "previous") {
    to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0))
      .toISOString()
      .slice(0, 10);
    from = `${to.slice(0, 7)}-01`;
  } else from = `${today.slice(0, 7)}-01`;
  const months = [...new Set(historyDates(from, to).map((d) => d.slice(0, 7)))];
  return { from, to, months };
}

/** UI entry point: a changed system date may invalidate an existing selection. */
export function resolveHistoryWindow(
  range: HistoryRange,
  today: string,
  selectedMonth = today.slice(0, 7),
): { window: HistoryWindow; error: null } | { window: null; error: string } {
  try {
    return { window: historyWindow(range, today, selectedMonth), error: null };
  } catch {
    return {
      window: null,
      error:
        range === "custom" && isHistoryDate(today)
          ? "请选择有效历史月份。系统时间可能已变化，当前选择已保留；请选择不晚于当前月份的月份。"
          : "当前系统日期无法生成有效历史区间，请检查系统时间后重试。",
    };
  }
}

export function historyDates(from: string, to: string): string[] {
  if (!isHistoryDate(from) || !isHistoryDate(to))
    throw new Error("无效历史区间");
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    end - start > 366 * 100 * 86400000
  )
    throw new Error("无效历史区间");
  return Array.from(
    { length: Math.round((end - start) / 86400000) + 1 },
    (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10),
  );
}

export function buildHistory(
  window: HistoryWindow,
  months: HistoryMonth[],
  failedMonths: string[],
  unloadedMonths: string[] = [],
): HistorySnapshot {
  const rows = new Map<string, HistoryRecord>();
  const returned = new Set<string>();
  const excludedDays: HistoryExcludedDay[] = [];
  for (const month of months) {
    // 复评 T10：晚于**请求发起时**记账日的行不算「已返回」——即使请求
    // 完成时已经跨过午夜。否则未来零占位会变成新一天的实测零。
    const asOf = month.sourceAsOfDate;
    for (const day of month.usage.days) {
      const reason = !isHistoryDate(day.date)
        ? "invalid-date"
        : day.date.slice(0, 7) !== month.month
          ? "outside-query-month"
          : null;
      if (reason) {
        // Capture evidence before window/source-date/unavailable filtering. A
        // malformed date must not disappear because of a string comparison,
        // nor be normalized into another real day's returned coverage.
        excludedDays.push({
          month: month.month,
          date: day.date,
          reason,
          message:
            reason === "invalid-date"
              ? "日期格式或公历日期无效，已排除正常合计"
              : "日期不属于所查询月份，已排除正常合计",
          fetchedAt: month.fetchedAt,
          sourceAsOfDate: asOf ?? null,
          accountingDate: month.usage.accountingDate ?? null,
          unavailable:
            Boolean(day.unavailable) ||
            Boolean(month.usage.unavailableDates?.includes(day.date)),
          models: day.rawModels ?? [],
          warnings: month.usage.warnings ?? [],
        });
        continue;
      }
      if (
        day.date < window.from ||
        day.date > window.to ||
        (asOf && day.date > asOf) ||
        day.unavailable
      )
        continue;
      if (
        !hasReturnedUsageDay(
          day,
          month.usage.unavailableDates,
          month.usage.accountingDate,
        )
      )
        continue;
      returned.add(day.date);
      for (const model of day.rawModels!)
        rows.set(`${day.date}\0${model.model}`, { date: day.date, model });
    }
  }
  // 未加载的月份不能被算成「平台未返回」：它们是「还没查」。
  const unloadedSet = new Set(unloadedMonths);
  return {
    window,
    months,
    failedMonths,
    excludedDays,
    rows: [...rows.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.model.model.localeCompare(b.model.model),
    ),
    missingDates: historyDates(window.from, window.to).filter(
      (date) => !returned.has(date) && !unloadedSet.has(date.slice(0, 7)),
    ),
    unloadedMonths: [...unloadedSet],
  };
}

/**
 * Advance only the displayed date window of an already account-checked snapshot.
 * Callers must verify the credential epoch and selection before retaining it.
 * Source request dates stay unchanged, so yesterday's future placeholders never
 * become today's returned zeroes. Newly encountered months are still unloaded.
 */
export function retainHistoryWindow(
  snapshot: HistorySnapshot,
  window: HistoryWindow,
): HistorySnapshot {
  const monthSet = new Set(window.months);
  const months = snapshot.months.filter((month) => monthSet.has(month.month));
  const failed = snapshot.failedMonths.filter((month) => monthSet.has(month));
  const attempted = new Set([...months.map((month) => month.month), ...failed]);
  return buildHistory(
    window,
    months,
    failed,
    window.months.filter((month) => !attempted.has(month)),
  );
}

/** One aggregation basis for page totals, monthly bars and JSON monthly rows. */
export function returnedHistoryModels(
  snapshot: HistorySnapshot,
  month?: string,
): RawModelUsage[] {
  return sumModels(
    snapshot.rows
      .filter((row) => month == null || row.date.slice(0, 7) === month)
      .map((row) => row.model),
  );
}

const fields = [
  "totalTokens",
  "requestCount",
  "cacheHitTokens",
  "cacheMissTokens",
  "responseTokens",
  "otherTokens",
  "cost",
] as const;
export function sumModels(models: RawModelUsage[]): RawModelUsage[] {
  const sums = new Map<string, RawModelUsage>();
  // 复评 F14：计数按 Token 规则（安全整数、非负）保护，金额只要求有限 ——
  // 不能把 Token 的整数约束套到金额上。溢出时该字段置 null 并留下
  // dataWarning，而不是返回一个超过 MAX_SAFE_INTEGER 的伪值。
  const overflowed = new Set<string>();
  const addCount = (
    existing: number | null | undefined,
    incoming: number | null | undefined,
  ): number | null => {
    if (existing == null || incoming == null) return null;
    const sum = existing + incoming;
    if (!Number.isSafeInteger(sum) || sum < 0) return null;
    return sum;
  };
  for (const model of models) {
    const existing = sums.get(model.model);
    if (!existing) {
      sums.set(model.model, { ...model });
      continue;
    }
    for (const field of fields) {
      const next =
        field === "cost"
          ? // 金额：只要有限即可（允许小数），非有限或缺失才是未知。
            existing[field] == null || model[field] == null
            ? null
            : Number.isFinite(existing[field]! + model[field]!)
              ? existing[field]! + model[field]!
              : null
          : addCount(existing[field], model[field]);
      if (next == null && existing[field] != null && model[field] != null)
        overflowed.add(model.model);
      existing[field] = next;
    }
    // 复评 F14：后出现条目的质量警告必须传播到合并结果 ——
    // 旧实现只保留首条对象的 warning，后续 warning 静默丢失。
    if (model.dataWarning && !existing.dataWarning)
      existing.dataWarning = model.dataWarning;
  }
  for (const model of sums.values()) {
    if (overflowed.has(model.model) && !model.dataWarning)
      model.dataWarning = "跨模型合计超出安全整数，相关字段保留为未知";
  }
  return [...sums.values()];
}

/**
 * 复评 R17：跨模型合计的安全版本，所有调用方共用。
 *
 * Token 计数逐步检查安全整数且非负（溢出返回 null，不产生伪值）；
 * 金额只要求有限（允许小数，不能被整数规则误伤）。缺失任一字段即整体未知。
 */
export function safeKnownSum(
  models: RawModelUsage[],
  field: "totalTokens" | "cost",
): number | null {
  if (!models.length) return null;
  if (models.some((model) => model[field] == null)) return null;
  let sum = 0;
  for (const model of models) {
    const value = model[field]!;
    if (!Number.isFinite(value)) return null;
    sum += value;
    // 复评 N16：**累计值**也必须每步检查 —— 金额 1e308 + 1e308 会得到
    // Infinity，旧实现只校验各输入有限，会把溢出当成正常金额展示。
    if (!Number.isFinite(sum)) return null;
    if (field !== "cost" && (!Number.isSafeInteger(sum) || sum < 0))
      return null;
  }
  return sum;
}

/** 复评 R11：严格 UTC 月末（`2024-02` → `2024-02-29`）。 */
export function monthEndDate(month: string): string {
  const [year, number] = month.split("-").map(Number);
  // Date.UTC 的 day=0 是「上个月最后一天」，用于取真实月末。
  const last = new Date(Date.UTC(year, number, 0));
  return last.toISOString().slice(0, 10);
}

export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function historyExport(
  snapshot: HistorySnapshot,
  generatedAt: number,
  stale = false,
) {
  const cleanModel = (model: RawModelUsage) => ({
    model: model.model,
    groupKey: model.groupKey,
    dataWarning: model.dataWarning ?? null,
    ...Object.fromEntries(
      fields.map((field) => [
        field,
        typeof model[field] === "number" && Number.isFinite(model[field])
          ? model[field]
          : null,
      ]),
    ),
  });
  const metadata = {
    schemaVersion: 2,
    generatedAt: new Date(generatedAt).toISOString(),
    source: "DeepSeek platform usage",
    accountingTimeZone: "Asia/Shanghai",
    currency: "CNY",
    accountScope: "current-local-usage-session",
    stale,
    aggregationBasis: "returned-daily-records",
    from: snapshot.window.from,
    to: snapshot.window.to,
    failedMonths: snapshot.failedMonths,
    missingDates: snapshot.missingDates,
    // 明确区分「没查」与「平台没给」：未加载月份不计入 missingDates。
    unloadedMonths: snapshot.unloadedMonths,
  };
  const daily = snapshot.rows.map((row) => ({
    date: row.date,
    ...cleanModel(row.model),
  }));
  // 复评 F06：`monthly` 必须与顶层 from/to 声称的**窗口口径**一致 ——
  // 旧实现直接取 API 返回的整月 rawModels，于是「近 30 天」导出的
  // daily/CSV 合计 3000 而 monthly 合计 3500（窗口外日期也被算进去），
  // 且 schema 没有标注两者口径不同。现在：
  // - `monthly`：按窗口内的 daily 重算的按月聚合（与页面/CSV 同源）；
  // - `sourceMonthlySnapshots`：原始整月来源数据，**显式**标注完整月边界
  //   与 `aggregationScope: "full-source-month"`，消费者不会误当窗口合计。
  const monthly = snapshot.months.map((month) => {
    const inWindow = snapshot.rows.filter(
      (row) => row.date.slice(0, 7) === month.month,
    );
    return {
      month: month.month,
      scope: "window",
      aggregationScope: "selected-window" as const,
      aggregationBasis: "returned-daily-records" as const,
      // 复评 F06：窗口内该月的日期覆盖情况显式给出，缺失日期不折算成 0。
      // 复评 R11：覆盖天数必须是**唯一日期数** —— 旧实现用行数，
      // 一天两个模型会被算成 2 天，误导覆盖率。
      coveredDates: new Set(inWindow.map((row) => row.date)).size,
      missingDates: snapshot.missingDates.filter((date) =>
        date.startsWith(month.month),
      ),
      sourceSchemaVersion: month.usage.schemaVersion ?? 1,
      modelMappingVersion: month.usage.modelMappingVersion ?? null,
      fetchedAt: new Date(month.fetchedAt).toISOString(),
      warnings: month.usage.warnings ?? [],
      excludedDateRecordCount: snapshot.excludedDays.filter(
        (day) => day.month === month.month,
      ).length,
      models: returnedHistoryModels(snapshot, month.month).map(cleanModel),
    };
  });
  const sourceMonthlySnapshots = snapshot.months.map((month) => ({
    month: month.month,
    scope: "full-source-month",
    aggregationScope: "full-source-month" as const,
    fullMonthFrom: `${month.month}-01`,
    // 复评 R11：真实月末（闰二月 29、平月 28/30），不再固定 -31。
    fullMonthTo: monthEndDate(month.month),
    sourceAsOfDate: month.sourceAsOfDate ?? month.usage.accountingDate ?? null,
    fetchedAt: new Date(month.fetchedAt).toISOString(),
    warnings: month.usage.warnings ?? [],
    models: (month.usage.rawModels ?? []).map(cleanModel),
  }));
  const excludedDateRecords = snapshot.excludedDays.map((day) => ({
    sourceMonth: day.month,
    date: day.date,
    status: `excluded-${day.reason}`,
    includedInTotals: false,
    reason: day.message,
    fetchedAt: new Date(day.fetchedAt).toISOString(),
    sourceAsOfDate: day.sourceAsOfDate,
    accountingDate: day.accountingDate,
    unavailable: day.unavailable,
    warnings: day.warnings,
    models: day.models.map(cleanModel),
  }));
  const header = [
    "date",
    "model",
    "group",
    ...fields,
    "currency",
    "status",
    "fetched_at",
    "source",
    "stale",
    "source_month",
    "source_as_of_date",
    "source_accounting_date",
    "date_issue",
    "warnings",
    "excluded_models",
  ];
  const records = snapshot.rows.map((row) => {
    const source = snapshot.months.find(
      (month) => month.month === row.date.slice(0, 7),
    )!;
    return [
      row.date,
      row.model.model,
      row.model.groupKey,
      ...fields.map((field) => row.model[field]),
      "CNY",
      "returned",
      new Date(source.fetchedAt).toISOString(),
      metadata.source,
      stale,
      source.month,
      source.sourceAsOfDate ?? null,
      source.usage.accountingDate ?? null,
      "",
      row.model.dataWarning ?? "",
      "",
    ];
  });
  for (const date of snapshot.missingDates)
    records.push([
      date,
      "",
      null,
      ...fields.map(() => null),
      "CNY",
      "not-returned",
      "",
      metadata.source,
      stale,
      date.slice(0, 7),
      null,
      null,
      "",
      "",
      "",
    ]);
  for (const day of excludedDateRecords)
    records.push([
      day.date,
      "",
      null,
      // Rejected source values live in an explicitly separate evidence column.
      // They cannot be mistaken for a returned count by ordinary CSV sums.
      ...fields.map(() => null),
      "CNY",
      day.status,
      day.fetchedAt,
      metadata.source,
      stale,
      day.sourceMonth,
      day.sourceAsOfDate,
      day.accountingDate,
      day.reason,
      JSON.stringify(day.warnings),
      JSON.stringify(day.models),
    ]);
  records.sort(
    (a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])),
  );
  return {
    json: JSON.stringify(
      {
        ...metadata,
        daily,
        monthly,
        sourceMonthlySnapshots,
        excludedDateRecords,
      },
      null,
      2,
    ),
    csv:
      "\uFEFF" +
      [header, ...records]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n") +
      "\r\n",
  };
}

/** Hide only explicit zero totals; unknowns, warnings and conflicting positive fields remain visible. */
export function isUnusedHistoryModel(model: RawModelUsage): boolean {
  return (
    model.totalTokens === 0 &&
    model.cost === 0 &&
    !model.dataWarning &&
    [
      model.requestCount,
      model.cacheHitTokens,
      model.cacheMissTokens,
      model.responseTokens,
      model.otherTokens,
    ].every((value) => value == null || value === 0)
  );
}
