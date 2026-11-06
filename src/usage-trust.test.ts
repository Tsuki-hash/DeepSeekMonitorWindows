import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usageCompleteness as completenessAt,
  usageTrust as trustAt,
  MONTH_SLOT_UNKNOWN_REASON,
  MONTH_SLOT_UNSAFE_REASON,
} from "./usage-trust.ts";
import type { UsageModel, UsageResult } from "./types.ts";
import {
  recentUsageDays,
  emptyUsageDay,
  chartPointFromDay,
  chartTotal,
  missingUsageDates,
} from "./format.ts";
import { buildHistory, historyWindow, historyExport } from "./history.ts";
import { usageNotices } from "./usage-notices.ts";

const NOW = new Date("2026-11-09T16:00:00Z");
const usageCompleteness = (usage: UsageResult | null, error: boolean) =>
  completenessAt(usage, error, NOW);
const usageTrust = (input: Parameters<typeof trustAt>[0]) =>
  trustAt({ ...input, now: NOW });
const rawZero = {
  model: "deepseek-flash",
  groupKey: "flash",
  totalTokens: 0,
  requestCount: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: 0,
  otherTokens: 0,
  cost: 0,
};
const returnedZero = (date: string) => ({
  date,
  rawModels: [rawZero],
  flashTokens: 0,
  flashCacheHit: 0,
  flashCacheMiss: 0,
  flashResponse: 0,
  proTokens: 0,
  proCacheHit: 0,
  proCacheMiss: 0,
  proResponse: 0,
  flashOtherTokens: 0,
  proOtherTokens: 0,
  totalTokens: 0,
  totalCost: 0,
});

const usage = (over: Partial<UsageResult> = {}): UsageResult => ({
  models: [],
  accountingDate: "2026-11-10",
  days: Array.from({ length: 10 }, (_, i) =>
    returnedZero(`2026-11-${String(i + 1).padStart(2, "0")}`),
  ),
  monthCost: 10,
  ...over,
});

test("有质量警告时必须标为部分_不能宣称完整", () => {
  assert.equal(
    usageCompleteness(
      usage({ warnings: ["费用与 Token 数据尚未完全对齐"] }),
      false,
    ),
    "partial",
  );
  assert.equal(
    usageCompleteness(usage({ unavailableDates: ["2026-10-02"] }), false),
    "partial",
  );
  // 缺本月费用同样是部分。
  assert.equal(usageCompleteness(usage({ monthCost: null }), false), "partial");
  // 无警告、无缺项才是完整。
  assert.equal(usageCompleteness(usage(), false), "complete");
});

test("本次请求失败且无已知缺陷时完整性为未知", () => {
  assert.equal(usageCompleteness(usage(), true), "unknown");
  assert.equal(usageCompleteness(null, false), "unknown");
  // 已知有警告时仍是 partial —— 失败不会让已知缺陷变成「未知」。
  assert.equal(
    usageCompleteness(usage({ warnings: ["对齐警告"] }), true),
    "partial",
  );
});

test("保留旧快照时标旧并给出原因_成功后清除", () => {
  const failed = usageTrust({
    usage: usage({ warnings: ["对齐警告"] }),
    state: "ok",
    error: "网络请求失败",
    updatedAt: 1000,
    snapshotMonth: "2026-11",
    currentMonth: "2026-11",
    lastSuccessText: "11-03 10:00:00",
  });
  assert.equal(failed.stale, true, "有数据但本次失败必须标旧");
  assert.equal(failed.completeness, "partial");
  assert.ok(failed.reason?.includes("对齐"));

  const recovered = usageTrust({
    usage: usage(),
    state: "ok",
    error: "",
    updatedAt: 2000,
    snapshotMonth: "2026-11",
    currentMonth: "2026-11",
    lastSuccessText: "11-03 10:05:00",
  });
  assert.equal(recovered.stale, false);
  assert.equal(recovered.completeness, "complete");
  assert.equal(recovered.reason, null);
});

test("跨月快照期间标注为快照所属月", () => {
  const trust = usageTrust({
    usage: usage({ accountingDate: "2026-10-31" }),
    state: "ok",
    error: "",
    updatedAt: 1000,
    snapshotMonth: "2026-10",
    currentMonth: "2026-11",
    lastSuccessText: null,
  });
  assert.ok(trust.period.startsWith("2026-10"), trust.period);
});

test("R14-06：同一源覆盖驱动图表、完整性、历史和 CSV", () => {
  const data = usage({ days: [returnedZero("2026-11-09")] });
  const days = recentUsageDays(data.days, 7, [], NOW);
  const history = buildHistory(
    historyWindow("month", "2026-11-10"),
    [
      {
        month: "2026-11",
        fetchedAt: NOW.getTime(),
        sourceAsOfDate: "2026-11-10",
        usage: data,
      },
    ],
    [],
  );
  assert.equal(days[6].totalTokens, null);
  assert.equal(chartPointFromDay(days[6]).unavailable, true);
  assert.equal(chartTotal(days.map((day) => chartPointFromDay(day))), null);
  assert.equal(usageCompleteness(data, false), "partial");
  assert.ok(usageNotices(data, NOW).length > 0);
  assert.ok(history.missingDates.includes("2026-11-10"));
  const exported = historyExport(history, NOW.getTime(), false);
  assert.ok(
    exported.csv
      .split("\n")
      .some(
        (line) => line.includes("2026-11-10") && line.includes("not-returned"),
      ),
  );
  assert.ok(
    exported.csv
      .split("\n")
      .some(
        (line) => line.includes("2026-11-09") && line.includes('"returned"'),
      ),
  );
});

test("R14-06：空数组、缺 rawModels、空 data 都不能宣称完整", () => {
  for (const days of [
    [],
    [emptyUsageDay("2026-11-10")],
    [{ ...returnedZero("2026-11-10"), rawModels: [] }],
  ]) {
    assert.equal(usageCompleteness(usage({ days }), false), "partial");
  }
  const explicit = usage();
  assert.equal(usageCompleteness(explicit, false), "complete");
  assert.equal(
    chartTotal(
      recentUsageDays(explicit.days, 7, [], NOW).map((day) =>
        chartPointFromDay(day),
      ),
    ),
    0,
  );
  const hole = usage({
    days: explicit.days.filter((day) => day.date !== "2026-11-01"),
  });
  assert.equal(
    usageCompleteness(hole, false),
    "partial",
    "近7日全有但本月较早缺日仍不能完整",
  );
});

test("R14-06：旧快照的未来显式零不能充当新日源覆盖", () => {
  const data = usage({ accountingDate: "2026-11-09" });
  assert.equal(usageCompleteness(data, false), "partial");
  const point = recentUsageDays(data.days, 7, [], NOW, data.accountingDate)[6];
  assert.equal(point.unavailable, true);
});

test("R14-06：完整月仅今天空 data 或缺原始行也必须部分，与历史一致", () => {
  for (const rawModels of [[], undefined]) {
    const data = usage();
    data.days = data.days.map((day) =>
      day.date === "2026-11-10" ? { ...day, rawModels } : day,
    );
    assert.equal(usageCompleteness(data, false), "partial");
    const history = buildHistory(
      historyWindow("month", "2026-11-10"),
      [
        {
          month: "2026-11",
          fetchedAt: NOW.getTime(),
          usage: data,
        },
      ],
      [],
    );
    assert.deepEqual(history.missingDates, ["2026-11-10"]);
  }
});

test("R14-06：失败日期及源快照上界在历史与图表中采用相同规则", () => {
  for (const data of [
    usage({ unavailableDates: ["2026-11-10"] }),
    usage({ accountingDate: "2026-11-09" }),
  ]) {
    const history = buildHistory(
      historyWindow("month", "2026-11-10"),
      [
        {
          month: "2026-11",
          fetchedAt: NOW.getTime(),
          usage: data,
        },
      ],
      [],
    );
    const days = recentUsageDays(
      data.days,
      7,
      data.unavailableDates,
      NOW,
      data.accountingDate,
    );
    assert.deepEqual(history.missingDates, ["2026-11-10"]);
    assert.equal(days[6].unavailable, true);
    assert.equal(usageCompleteness(data, false), "partial");
  }
});

test("R14-06：未来未知占位不能降低当前完整覆盖，旧版无日期样本可注入时钟", () => {
  const data = usage({ accountingDate: undefined });
  data.days.push(emptyUsageDay("2026-11-11"));
  assert.equal(usageCompleteness(data, false), "complete");
  assert.equal(
    usageCompleteness(usage({ accountingDate: undefined, days: [] }), false),
    "partial",
  );
});

test("R25：跨月真实月快照各自合法，近7日超界不可标完整或缺日期", () => {
  const now = new Date("2026-11-02T02:00:00Z");
  const countDay = (date: string, tokens: number) => ({
    ...returnedZero(date),
    flashTokens: tokens,
    flashCacheHit: tokens,
    totalTokens: tokens,
    rawModels: [{ ...rawZero, totalTokens: tokens, cacheHitTokens: tokens }],
  });
  for (const currentCount of [2 ** 52 - 1, 2 ** 52 + 1]) {
    const safe = currentCount === 2 ** 52 - 1;
    const previous = usage({
      accountingDate: "2026-10-31",
      monthCost: 0,
      days: [
        ...[27, 28, 29, 30].map((date) => countDay(`2026-10-${date}`, 0)),
        countDay("2026-10-31", 2 ** 52),
      ],
      rawModels: [
        { ...rawZero, totalTokens: 2 ** 52, cacheHitTokens: 2 ** 52 },
      ],
    });
    const current = usage({
      accountingDate: "2026-11-02",
      monthCost: 0,
      days: [countDay("2026-11-01", currentCount), countDay("2026-11-02", 0)],
      rawModels: [
        { ...rawZero, totalTokens: currentCount, cacheHitTokens: currentCount },
      ],
      models: [
        {
          key: "flash",
          name: "V4.1 Flash",
          totalTokens: currentCount,
          requestCount: 0,
          cacheHitTokens: currentCount,
          cacheMissTokens: 0,
          responseTokens: 0,
          otherTokens: 0,
          cost: 0,
        },
      ],
    });
    const data = { ...current, days: [...previous.days, ...current.days] };
    const before = JSON.stringify(data);
    assert.equal(
      completenessAt(data, false, now),
      safe ? "complete" : "partial",
    );
    assert.deepEqual(missingUsageDates(data, now), []);
    assert.deepEqual(usageNotices(data, now), [], "超界不是源日期缺失");
    const trust = trustAt({
      usage: data,
      state: "ok",
      error: "",
      updatedAt: now.getTime(),
      snapshotMonth: "2026-11",
      currentMonth: "2026-11",
      lastSuccessText: null,
      now,
    });
    assert.equal(trust.completeness, safe ? "complete" : "partial");
    assert.equal(trust.stale, false);
    if (safe) assert.equal(trust.reason, null);
    else {
      assert.ok(trust.reason?.includes("超出安全整数"));
      assert.ok(!trust.reason?.includes("日期未取得"));
    }
    const history = buildHistory(
      { from: "2026-10-27", to: "2026-11-02", months: ["2026-10", "2026-11"] },
      [
        { month: "2026-10", fetchedAt: now.getTime(), usage: previous },
        { month: "2026-11", fetchedAt: now.getTime(), usage: current },
      ],
      [],
    );
    const exported = JSON.parse(historyExport(history, now.getTime()).json);
    assert.deepEqual(exported.missingDates, []);
    assert.equal(exported.daily.length, 7);
    assert.equal(exported.daily[4].totalTokens, 2 ** 52);
    assert.equal(exported.daily[5].totalTokens, currentCount);
    assert.equal(exported.daily[6].totalTokens, 0);
    assert.deepEqual(
      exported.monthly.map(
        (item: { models: { totalTokens: number }[] }) =>
          item.models[0].totalTokens,
      ),
      [2 ** 52, currentCount],
    );
    assert.equal(
      JSON.stringify(data),
      before,
      "前端降级不得改写原始数据或JSON来源",
    );
  }
});

test("R25：已返回的别名合计超界有明确原因，不变成缺日期", () => {
  const data = usage();
  data.days[9] = {
    ...returnedZero("2026-11-10"),
    flashTokens: null,
    totalTokens: null,
    flashCacheHit: 2 ** 52,
    flashCacheMiss: 2 ** 52 + 1,
    rawModels: [
      {
        ...rawZero,
        model: "deepseek-v4-flash",
        totalTokens: 2 ** 52,
        cacheHitTokens: 2 ** 52,
      },
      {
        ...rawZero,
        model: "deepseek-flash",
        totalTokens: 2 ** 52 + 1,
        cacheMissTokens: 2 ** 52 + 1,
      },
    ],
  };
  assert.equal(usageCompleteness(data, false), "partial");
  assert.deepEqual(missingUsageDates(data, NOW), []);
  const trust = usageTrust({
    usage: data,
    state: "ok",
    error: "",
    updatedAt: 1,
    snapshotMonth: "2026-11",
    currentMonth: "2026-11",
    lastSuccessText: null,
  });
  assert.ok(trust.reason?.includes("2026-11-10"));
  assert.ok(trust.reason?.includes("超出安全整数"));
});

const monthSlot = (over: Partial<UsageModel> = {}): UsageModel => ({
  key: "flash",
  name: "V4.1 Flash",
  totalTokens: 0,
  requestCount: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: 0,
  otherTokens: 0,
  cost: 0,
  ...over,
});
const trustFor = (data: UsageResult) =>
  usageTrust({
    usage: data,
    state: "ok",
    error: "",
    updatedAt: NOW.getTime(),
    snapshotMonth: "2026-11",
    currentMonth: "2026-11",
    lastSuccessText: null,
  });

test("R26：近7日外月槽位跨别名刚好MAX安全，超界1必须部分且保留日柱/raw", () => {
  for (const second of [2 ** 52 - 1, 2 ** 52]) {
    const safe = second === 2 ** 52 - 1;
    const rawModels = [
      { ...rawZero, totalTokens: 2 ** 52, cacheHitTokens: 2 ** 52 },
      {
        ...rawZero,
        model: "deepseek-v4-flash",
        totalTokens: second,
        cacheMissTokens: second,
      },
    ];
    const data = usage({
      rawModels,
      models: [
        monthSlot({
          totalTokens: safe ? Number.MAX_SAFE_INTEGER : null,
          cacheHitTokens: 2 ** 52,
          cacheMissTokens: second,
        }),
        monthSlot({ key: "pro", name: "V4 Pro" }),
      ],
    });
    data.days[0] = {
      ...returnedZero("2026-11-01"),
      totalTokens: 2 ** 52,
      flashTokens: 2 ** 52,
      flashCacheHit: 2 ** 52,
      rawModels: [rawModels[0]],
    };
    data.days[1] = {
      ...returnedZero("2026-11-02"),
      totalTokens: second,
      flashTokens: second,
      flashCacheMiss: second,
      rawModels: [rawModels[1]],
    };
    const before = JSON.stringify(data);
    assert.deepEqual(missingUsageDates(data, NOW), []);
    assert.deepEqual(usageNotices(data, NOW), []);
    const points = data.days.map((day) => chartPointFromDay(day));
    assert.ok(points.every((point) => !point.unavailable));
    assert.equal(chartTotal(points.slice(-7)), 0);
    assert.equal(usageCompleteness(data, false), safe ? "complete" : "partial");
    assert.equal(trustFor(data).reason, safe ? null : MONTH_SLOT_UNSAFE_REASON);
    assert.equal(trustFor(data).stale, false);
    assert.equal(
      JSON.stringify(data),
      before,
      "月状态降级不能改写日柱、兄弟槽位或 raw",
    );
  }
});

test("R26：仅已返回月槽位的缺项/不安全计数降级，空槽位列表及显式零保持完整", () => {
  for (const models of [[], [monthSlot()], [monthSlot({ key: "pro" })]]) {
    assert.equal(trustFor(usage({ models })).completeness, "complete");
    assert.equal(trustFor(usage({ models })).reason, null);
  }
  for (const field of [
    "totalTokens",
    "requestCount",
    "cacheHitTokens",
    "cacheMissTokens",
    "responseTokens",
    "otherTokens",
  ] as const) {
    for (const value of [null, Number.MAX_SAFE_INTEGER + 1]) {
      const data = usage({ models: [monthSlot({ [field]: value })] });
      assert.equal(usageCompleteness(data, false), "partial", field);
      assert.equal(
        trustFor(data).reason,
        value == null ? MONTH_SLOT_UNKNOWN_REASON : MONTH_SLOT_UNSAFE_REASON,
        field,
      );
    }
  }
});

test("R26：月槽位未知总量不能被安全分段覆盖；raw别名超界给出准确原因", () => {
  const data = usage({
    models: [monthSlot({ totalTokens: null })],
    rawModels: [rawZero],
  });
  assert.equal(trustFor(data).completeness, "partial");
  assert.equal(trustFor(data).reason, MONTH_SLOT_UNKNOWN_REASON);
  data.rawModels = [
    { ...rawZero, totalTokens: Number.MAX_SAFE_INTEGER },
    { ...rawZero, model: "deepseek-v4-flash", totalTokens: 1 },
  ];
  assert.equal(trustFor(data).reason, MONTH_SLOT_UNSAFE_REASON);
  data.models = [monthSlot({ key: "other", totalTokens: null })];
  data.rawModels = data.rawModels!.map((item) => ({ ...item, groupKey: null }));
  assert.equal(trustFor(data).reason, MONTH_SLOT_UNSAFE_REASON);
  data.rawModels = data.rawModels.map((item) => ({
    ...item,
    groupKey: "future-group",
  }));
  assert.equal(trustFor(data).reason, MONTH_SLOT_UNSAFE_REASON);
  data.rawModels = data.rawModels.map((item) => {
    const legacy = { ...item };
    Reflect.deleteProperty(legacy, "groupKey");
    return legacy;
  });
  assert.equal(trustFor(data).completeness, "partial");
  assert.equal(trustFor(data).reason, MONTH_SLOT_UNKNOWN_REASON);
});

test("R26：合法单侧零及MAX计数保持完整，不跨兄弟月槽位相加", () => {
  for (const hit of [0, Number.MAX_SAFE_INTEGER]) {
    const data = usage({
      models: [
        monthSlot({
          totalTokens: Number.MAX_SAFE_INTEGER,
          requestCount: Number.MAX_SAFE_INTEGER,
          cacheHitTokens: hit,
          cacheMissTokens: Number.MAX_SAFE_INTEGER - hit,
        }),
        monthSlot({
          key: "pro",
          totalTokens: 1,
          cacheHitTokens: 1,
        }),
      ],
    });
    assert.equal(trustFor(data).completeness, "complete");
    assert.equal(trustFor(data).reason, null);
  }
});
