import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usageCompleteness as completenessAt,
  usageTrust as trustAt,
} from "./usage-trust.ts";
import type { UsageResult } from "./types.ts";
import {
  recentUsageDays,
  emptyUsageDay,
  chartPointFromDay,
  chartTotal,
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

test("账户匹配始终标未核对_不伪造自动核对", () => {
  assert.equal(
    usageTrust({
      usage: usage(),
      state: "ok",
      error: "",
      updatedAt: 1,
      snapshotMonth: "2026-11",
      currentMonth: "2026-11",
      lastSuccessText: null,
    }).accountVerified,
    false,
  );
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
