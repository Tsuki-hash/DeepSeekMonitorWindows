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
  // 复评 F06：原始整月来源数据改名为 sourceMonthlySnapshots；
  // 未知值（cost=null）与白名单字段在这条路径上同样必须保留。
  assert.equal(parsed.sourceMonthlySnapshots[0].models[0].cost, null);
  assert.equal(parsed.monthly[0].aggregationScope, "selected-window");
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

test("未加载月份不算平台未返回_分批加载不伪造缺失日期", () => {
  const all = historyWindow("all", "2026-10-10");
  const unloaded = all.months.slice(0, 70);
  const loaded = all.months.slice(-12);
  const result = buildHistory(all, [], [], unloaded);
  assert.deepEqual(result.unloadedMonths, unloaded);
  // 未加载的 2020-01..2025-10 不应出现在 missingDates；只有已加载月份才可能缺失。
  assert.equal(
    result.missingDates.some((date) => date.startsWith("2020-01")),
    false,
  );
  assert.ok(
    result.missingDates.every((date) => loaded.includes(date.slice(0, 7))),
  );
  // 不传 unloaded 时行为与旧版一致（用于非分批区间）。
  assert.equal(
    buildHistory(all, [], []).missingDates.some((date) =>
      date.startsWith("2020-01"),
    ),
    true,
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

// ---------- 第七轮复评 F06：JSON 的 monthly 必须是窗口口径 ----------

const usageModel = (
  tokens: number,
  cost: number | null = 0,
): RawModelUsage => ({
  model: "deepseek-flash",
  groupKey: "flash",
  totalTokens: tokens,
  requestCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: tokens,
  otherTokens: 0,
  cost,
});

const usageMonth = (
  month: string,
  total: number,
  days: Array<[string, number]>,
) => ({
  month,
  fetchedAt: Date.parse("2026-11-04T08:00:00Z"),
  usage: {
    schemaVersion: 2,
    models: [],
    rawModels: [usageModel(total)],
    monthCost: 0,
    days: days.map(([date, tokens]) => ({
      date,
      rawModels: [usageModel(tokens)],
    })),
  } as unknown as UsageResult,
});

test("F06：近30天 JSON 的 monthly 与页面/CSV 窗口合计一致", () => {
  const now = Date.parse("2026-11-04T08:00:00Z");
  const snapshot = buildHistory(
    historyWindow("30days", "2026-11-04"),
    [
      // 10 月整月 3100，其中 10-01 的 500 在窗口外。
      usageMonth("2026-10", 3100, [
        ["2026-10-01", 500],
        ["2026-10-06", 2600],
      ]),
      usageMonth("2026-11", 400, [["2026-11-04", 400]]),
    ],
    [],
  );
  const pageTokens = sumModels(snapshot.rows.map((row) => row.model))[0]
    .totalTokens;
  const json = JSON.parse(historyExport(snapshot, now).json);
  const monthlyTokens = json.monthly
    .flatMap((month: { models: RawModelUsage[] }) => month.models)
    .reduce(
      (sum: number, model: RawModelUsage) => sum + (model.totalTokens ?? 0),
      0,
    );
  const dailyTokens = json.daily.reduce(
    (sum: number, row: RawModelUsage) => sum + (row.totalTokens ?? 0),
    0,
  );
  assert.equal(pageTokens, 3000, "页面合计只含窗口内日期");
  assert.equal(dailyTokens, 3000, "daily 与页面同源");
  assert.equal(
    monthlyTokens,
    3000,
    "monthly 必须与窗口口径一致，不能是整月 3500",
  );
  for (const month of json.monthly)
    assert.equal(month.aggregationScope, "selected-window");
  // 原始整月来源必须显式独立标记，消费者不会误当窗口合计。
  const source = json.sourceMonthlySnapshots;
  assert.ok(source.length > 0, "原始来源月快照保留但独立命名");
  for (const month of source) {
    assert.equal(month.aggregationScope, "full-source-month");
    assert.equal(month.scope, "full-source-month");
  }
  assert.equal(
    source
      .flatMap((month: { models: RawModelUsage[] }) => month.models)
      .reduce(
        (sum: number, model: RawModelUsage) => sum + (model.totalTokens ?? 0),
        0,
      ),
    3500,
    "原始来源保留整月数值，但与窗口口径分开标注",
  );
});

// ---------- 第七轮复评 F14：安全整数与 warning 传播 ----------

test("F14：跨模型合计溢出为未知而不是不安全整数", () => {
  const summed = sumModels([usageModel(9007199254740990), usageModel(3)]);
  assert.equal(
    summed[0].totalTokens,
    null,
    "超过 MAX_SAFE_INTEGER 的合计必须置未知",
  );
  assert.ok(summed[0].dataWarning, "溢出必须留下质量提示，而不是静默返回伪值");
  // 未溢出时正常相加。
  const normal = sumModels([usageModel(100), usageModel(20)]);
  assert.equal(normal[0].totalTokens, 120);
});

test("F14：金额保留小数且不套用整数规则", () => {
  const summed = sumModels([usageModel(10, 0.1), usageModel(10, 0.2)]);
  assert.ok(
    Math.abs((summed[0].cost ?? 0) - 0.3) < 1e-9,
    "金额按有限数规则相加，允许小数",
  );
});

test("F14：后出现条目的质量警告传播到合并结果", () => {
  const summed = sumModels([
    usageModel(10),
    { ...usageModel(10), dataWarning: "later-month-warning" },
  ]);
  assert.equal(
    summed[0].dataWarning,
    "later-month-warning",
    "后续条目的 warning 不能被丢弃",
  );
});
