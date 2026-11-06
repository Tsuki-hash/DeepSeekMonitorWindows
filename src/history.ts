import type { RawModelUsage, UsageResult } from "./types";
export type HistoryRange = "month" | "previous" | "30days" | "custom" | "all";
export type HistoryWindow = { from: string; to: string; months: string[] };
export type HistoryMonth = {
  month: string;
  fetchedAt: number;
  usage: UsageResult;
};
export type HistoryRecord = { date: string; model: RawModelUsage };
export type HistorySnapshot = {
  window: HistoryWindow;
  months: HistoryMonth[];
  rows: HistoryRecord[];
  missingDates: string[];
  failedMonths: string[];
  /** 尚未加载的月份（全部历史分批加载）：这些月份不能算作「未返回」。 */
  unloadedMonths: string[];
};

export function historyWindow(
  range: HistoryRange,
  today: string,
  selectedMonth = today.slice(0, 7),
): HistoryWindow {
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

export function historyDates(from: string, to: string): string[] {
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
  for (const month of months) {
    for (const day of month.usage.days) {
      if (
        day.date.slice(0, 7) !== month.month ||
        day.date < window.from ||
        day.date > window.to ||
        day.unavailable
      )
        continue;
      if (!day.rawModels) continue;
      if (day.rawModels.length) returned.add(day.date);
      for (const model of day.rawModels)
        rows.set(`${day.date}\0${model.model}`, { date: day.date, model });
    }
  }
  // 未加载的月份不能被算成「平台未返回」：它们是「还没查」。
  const unloadedSet = new Set(unloadedMonths);
  return {
    window,
    months,
    failedMonths,
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
      models: sumModels(inWindow.map((row) => row.model)).map(cleanModel),
    };
  });
  const sourceMonthlySnapshots = snapshot.months.map((month) => ({
    month: month.month,
    scope: "full-source-month",
    aggregationScope: "full-source-month" as const,
    fullMonthFrom: `${month.month}-01`,
    // 复评 R11：真实月末（闰二月 29、平月 28/30），不再固定 -31。
    fullMonthTo: monthEndDate(month.month),
    fetchedAt: new Date(month.fetchedAt).toISOString(),
    models: (month.usage.rawModels ?? []).map(cleanModel),
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
  ];
  const records = snapshot.rows.map((row) => [
    row.date,
    row.model.model,
    row.model.groupKey,
    ...fields.map((field) => row.model[field]),
    "CNY",
    "returned",
    new Date(
      snapshot.months.find((m) => m.month === row.date.slice(0, 7))!.fetchedAt,
    ).toISOString(),
    metadata.source,
    stale,
  ]);
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
    ]);
  records.sort(
    (a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])),
  );
  return {
    json: JSON.stringify(
      { ...metadata, daily, monthly, sourceMonthlySnapshots },
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
