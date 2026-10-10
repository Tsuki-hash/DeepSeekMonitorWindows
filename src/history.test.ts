import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historyWindow,
  buildHistory,
  historyExport,
  sumModels,
  csvCell,
  isUnusedHistoryModel,
} from "./history.ts";
import { HistoryCache } from "./history-cache.ts";
import type { RawModelUsage, UsageResult } from "./types";
const model = (name = "new-model"): RawModelUsage => ({
  model: name,
  groupKey: null,
  totalTokens: 10,
  requestCount: null,
  cacheHitTokens: null,
  cacheMissTokens: null,
  responseTokens: 10,
  otherTokens: 0,
  cost: null,
});
const usage = (): UsageResult => ({
  schemaVersion: 2,
  rawModels: [model()],
  models: [],
  days: [],
  monthCost: 0,
});

test("历史区间跨年、闰月及近30天跨三个月", () => {
  assert.deepEqual(historyWindow("previous", "2026-01-08"), {
    from: "2025-12-01",
    to: "2025-12-31",
    months: ["2025-12"],
  });
  assert.equal(historyWindow("previous", "2024-03-01").to, "2024-02-29");
  assert.deepEqual(historyWindow("30days", "2026-03-01"), {
    from: "2026-01-31",
    to: "2026-03-01",
    months: ["2026-01", "2026-02", "2026-03"],
  });
});

test("历史缺失标未知，重复日期原始模型不重复累计", () => {
  const data = usage();
  data.days = [
    { date: "2026-10-01", rawModels: [model()] },
    { date: "2026-10-01", rawModels: [model()] },
    { date: "2026-10-09", rawModels: [model()] },
  ] as UsageResult["days"];
  const result = buildHistory(
    historyWindow("month", "2026-10-03"),
    [{ month: "2026-10", fetchedAt: 1, usage: data }],
    [],
  );
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.missingDates, ["2026-10-02", "2026-10-03"]);
});

test("原始模型不按槽位吞并，汇总缺失费用不变零", () => {
  const result = sumModels([
    model("deepseek-flash"),
    model("deepseek-v4-flash"),
    model("deepseek-flash"),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].totalTokens, 20);
  assert.equal(result[0].cost, null);
});

test("导出白名单排除凭据，保留未知与查询来源", () => {
  const data = Object.assign(usage(), {
    apiKey: "TOP_SECRET",
    token: "TOP_SECRET",
  });
  const snapshot = buildHistory(
    historyWindow("month", "2026-10-02"),
    [{ month: "2026-10", usage: data, fetchedAt: 0 }],
    [],
  );
  const result = historyExport(snapshot, 0, true);
  assert.equal(result.json.includes("TOP_SECRET"), false);
  const parsed = JSON.parse(result.json);
  assert.equal(parsed.monthly[0].models[0].cost, null);
  assert.equal(parsed.currency, "CNY");
  assert.equal(parsed.stale, true);
  assert.ok(result.csv.startsWith("\uFEFF"));
  assert.ok(result.csv.includes('"not-returned"'));
});

test("CSV防公式注入与逗号换行双引号转义", () => {
  for (const value of ["=SUM(1,2)", " +cmd", "\t@cmd", "-cmd", "\rformula"])
    assert.ok(csvCell(value).startsWith("\"'"));
  assert.equal(csvCell('模型,"quoted"\n新行'), '"模型,""quoted""\n新行"');
  assert.equal(csvCell(null), '""');
});

test("缓存合并并发查询，强制更新替换而非累加", async () => {
  const cache = new HistoryCache();
  let calls = 0;
  const loader = async () => {
    calls++;
    return usage();
  };
  await Promise.all([
    cache.get("2026-10", loader),
    cache.get("2026-10", loader),
  ]);
  assert.equal(calls, 1);
  await cache.get("2026-10", loader);
  assert.equal(calls, 1);
  await cache.get("2026-10", loader, true);
  assert.equal(calls, 2);
});

test("凭据会话变化清缓存并拒绝迟到响应", async () => {
  const cache = new HistoryCache();
  let finish: (value: UsageResult) => void = () => {};
  const pending = cache.get(
    "2026-10",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  cache.invalidate();
  finish(usage());
  await assert.rejects(() => pending);
  let called = false;
  await cache.get("2026-10", async () => {
    called = true;
    return usage();
  });
  assert.equal(called, true);
});

test("历史刷新失败不覆盖最后成功缓存，过期后重新查询", async () => {
  const cache = new HistoryCache();
  await cache.get(
    "2026-10",
    async () => usage(),
    false,
    () => 1000,
  );
  await assert.rejects(() =>
    cache.get(
      "2026-10",
      async () => {
        throw new Error("offline");
      },
      true,
      () => 1100,
    ),
  );
  let calls = 0;
  await cache.get(
    "2026-10",
    async () => {
      calls++;
      return usage();
    },
    false,
    () => 1200,
  );
  assert.equal(calls, 0);
  await cache.get(
    "2026-10",
    async () => {
      calls++;
      return usage();
    },
    false,
    () => 302000,
  );
  assert.equal(calls, 1);
});

test("历史月份支持闰月与边界，全部历史跨多年且不包含未来月份", () => {
  assert.deepEqual(historyWindow("custom", "2026-10-10", "2024-02"), {
    from: "2024-02-01",
    to: "2024-02-29",
    months: ["2024-02"],
  });
  assert.throws(() => historyWindow("custom", "2026-10-10", "2026-11"));
  assert.throws(() => historyWindow("custom", "2026-10-10", "2019-12"));
  const all = historyWindow("all", "2026-10-10");
  assert.equal(all.from, "2020-01-01");
  assert.equal(all.to, "2026-10-10");
  assert.equal(all.months.length, 82);
  assert.equal(all.months[81], "2026-10");
  assert.equal(
    buildHistory(all, [], ["2020-01"]).missingDates[0],
    "2020-01-01",
  );
});

test("历史展示隐藏明确零用量，不隐藏未知、费用、请求或异常数据", () => {
  const zero = {
    ...model("old-model"),
    totalTokens: 0,
    responseTokens: 0,
    cost: 0,
  };
  assert.equal(isUnusedHistoryModel(zero), true);
  for (const changed of [
    { cost: null },
    { totalTokens: null },
    { cost: 0.01 },
    { requestCount: 1 },
    { responseTokens: 2 },
    { dataWarning: "数据待核对" },
  ])
    assert.equal(isUnusedHistoryModel({ ...zero, ...changed }), false);
  assert.equal(isUnusedHistoryModel({ ...zero, totalTokens: 123 }), false);
});
