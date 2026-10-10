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
      (d) => !returned.has(d),
    ),
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
  for (const model of models) {
    const existing = sums.get(model.model);
    if (!existing) sums.set(model.model, { ...model });
    else
      for (const field of fields)
        existing[field] =
          existing[field] == null || model[field] == null
            ? null
            : existing[field]! + model[field]!;
  }
  return [...sums.values()];
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
  };
  const daily = snapshot.rows.map((row) => ({
    date: row.date,
    ...cleanModel(row.model),
  }));
  const monthly = snapshot.months.map((month) => ({
    month: month.month,
    sourceSchemaVersion: month.usage.schemaVersion ?? 1,
    modelMappingVersion: month.usage.modelMappingVersion ?? null,
    fetchedAt: new Date(month.fetchedAt).toISOString(),
    warnings: month.usage.warnings ?? [],
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
    json: JSON.stringify({ ...metadata, daily, monthly }, null, 2),
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
