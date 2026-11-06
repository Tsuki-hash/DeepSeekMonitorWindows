import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historyWindow,
  historyDates,
  isHistoryDate,
  buildHistory,
  retainHistoryWindow,
  returnedHistoryModels,
  historyExport,
  sumModels,
  safeKnownSum,
  monthEndDate,
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
  await assert.rejects(() =>
    cache.get(
      "2026-10",
      async () => {
        calls++;
        return usage();
      },
      false,
      () => 1200,
    ),
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

// ---------- 第八轮复评 R11：覆盖天数与真实月末 ----------

test("R11：coveredDates 是唯一日期数，不是行数", () => {
  const now = Date.parse("2026-11-04T08:00:00Z");
  const model = (tokens: number) => ({
    model: "deepseek-flash",
    groupKey: "flash",
    totalTokens: tokens,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: tokens,
    otherTokens: 0,
    cost: 0,
  });
  const snapshot = buildHistory(
    historyWindow("month", "2026-10-02"),
    [
      {
        month: "2026-10",
        fetchedAt: now,
        usage: {
          schemaVersion: 2,
          models: [],
          rawModels: [model(100)],
          monthCost: 0,
          // 同一天两个模型 → 行数 2，但唯一日期只有 1。
          days: [
            {
              date: "2026-10-01",
              rawModels: [model(50), { ...model(50), model: "deepseek-pro" }],
            },
          ],
        } as unknown as UsageResult,
      },
    ],
    [],
  );
  const json = JSON.parse(historyExport(snapshot, now).json);
  assert.equal(json.monthly[0].coveredDates, 1, "一天两个模型只能算 1 天覆盖");
});

test("R11：整月截止日使用真实月末（闰二月/短月）", () => {
  assert.equal(monthEndDate("2024-02"), "2024-02-29", "闰年二月 29");
  assert.equal(monthEndDate("2023-02"), "2023-02-28", "平年二月 28");
  assert.equal(monthEndDate("2026-04"), "2026-04-30", "四月 30");
  assert.equal(monthEndDate("2026-06"), "2026-06-30", "六月 30");
  assert.equal(monthEndDate("2026-09"), "2026-09-30", "九月 30");
  assert.equal(monthEndDate("2026-11"), "2026-11-30", "十一月 30");
  assert.equal(monthEndDate("2026-01"), "2026-01-31", "一月 31");
  assert.equal(monthEndDate("2026-12"), "2026-12-31", "十二月 31");
});

test("R11：导出里的 fullMonthTo 不再出现 -31 的短月", () => {
  const now = Date.parse("2026-11-04T08:00:00Z");
  const snapshot = buildHistory(
    historyWindow("30days", "2026-11-04"),
    [
      {
        month: "2026-11",
        fetchedAt: now,
        usage: {
          schemaVersion: 2,
          models: [],
          rawModels: [],
          monthCost: 0,
          days: [],
        } as unknown as UsageResult,
      },
    ],
    [],
  );
  const json = JSON.parse(historyExport(snapshot, now).json);
  assert.equal(
    json.sourceMonthlySnapshots[0].fullMonthTo,
    "2026-11-30",
    "十一月不能是 2026-11-31",
  );
});

// ---------- 第八轮复评 R17：跨模型合计的安全版本 ----------

test("R17：跨模型 Token 合计溢出返回 null，金额保留小数", () => {
  const model = (tokens: number, cost: number) => ({
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
  // MAX_SAFE_INTEGER + 2 → 溢出，必须 null。
  assert.equal(
    safeKnownSum(
      [model(Number.MAX_SAFE_INTEGER, 0), model(2, 0)],
      "totalTokens",
    ),
    null,
    "跨模型合计超过安全整数必须为未知",
  );
  // 正常范围相加。
  assert.equal(safeKnownSum([model(100, 0), model(20, 0)], "totalTokens"), 120);
  // 金额允许小数（不能被整数规则误伤）。
  const cost = safeKnownSum([model(10, 0.1), model(10, 0.2)], "cost");
  assert.ok(cost != null && Math.abs(cost - 0.3) < 1e-9, "费用 0.1+0.2=0.3");
  // 缺失字段即整体未知。
  assert.equal(
    safeKnownSum(
      [{ ...model(10, 0), totalTokens: null }, model(10, 0)],
      "totalTokens",
    ),
    null,
  );
  // 空数组未知。
  assert.equal(safeKnownSum([], "totalTokens"), null);
});

// ---------- 第九轮复评 N16：极端金额累计溢出 ----------

test("N16：金额累计溢出为未知，且不会把 1e308+1e308 当正常金额", () => {
  const model = (cost: number) => ({
    model: "deepseek-flash",
    groupKey: "flash",
    totalTokens: 0,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: 0,
    otherTokens: 0,
    cost,
  });
  const summed = safeKnownSum([model(1e308), model(1e308)], "cost");
  assert.equal(
    summed,
    null,
    "1e308 + 1e308 溢出为 Infinity，必须返回未知而不是 Infinity",
  );
  // 正常小数仍可用。
  const ok = safeKnownSum([model(0.1), model(0.2)], "cost");
  assert.ok(ok != null && Math.abs(ok - 0.3) < 1e-9);
});

// ---------- 第十轮复评 T10：跨记账午夜的未来零占位 ----------

test("T10：晚于请求发起记账日的行不算已返回", () => {
  const now = Date.parse("2026-11-05T00:00:30Z"); // 北京 08:00:30，新的一天
  const model = (tokens: number) => ({
    model: "deepseek-flash",
    groupKey: "flash",
    totalTokens: tokens,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: tokens,
    otherTokens: 0,
    cost: 0,
  });
  // 请求在 11-04 23:59:30 发起（sourceAsOfDate = 2026-11-04），
  // 响应里含 11-05 的零占位行 —— 跨午夜后它不该变成「今天实测 0」。
  const snapshot = buildHistory(
    historyWindow("month", "2026-11-05"),
    [
      {
        month: "2026-11",
        fetchedAt: now,
        sourceAsOfDate: "2026-11-04",
        usage: {
          schemaVersion: 2,
          models: [],
          rawModels: [model(100)],
          monthCost: 0,
          days: [
            { date: "2026-11-04", rawModels: [model(100)] },
            { date: "2026-11-05", rawModels: [model(0)] },
          ],
        } as unknown as UsageResult,
      },
    ],
    [],
  );
  assert.equal(
    snapshot.rows.some((row) => row.date === "2026-11-05"),
    false,
    "晚于 sourceAsOfDate 的行必须被拒绝（否则未来零占位变成实测零）",
  );
  assert.equal(
    snapshot.rows.some((row) => row.date === "2026-11-04"),
    true,
    "窗口内的真实数据保留",
  );
});

test("T10：未记录 sourceAsOfDate 时不过滤（兼容旧夹具）", () => {
  const now = Date.parse("2026-11-05T00:00:30Z");
  const model = (tokens: number) => ({
    model: "deepseek-flash",
    groupKey: "flash",
    totalTokens: tokens,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: tokens,
    otherTokens: 0,
    cost: 0,
  });
  const snapshot = buildHistory(
    historyWindow("month", "2026-11-05"),
    [
      {
        month: "2026-11",
        fetchedAt: now,
        usage: {
          schemaVersion: 2,
          models: [],
          rawModels: [model(100)],
          monthCost: 0,
          days: [{ date: "2026-11-05", rawModels: [model(100)] }],
        } as unknown as UsageResult,
      },
    ],
    [],
  );
  assert.equal(snapshot.rows.length, 1, "无 sourceAsOfDate 时不做额外过滤");
});

// ---------- Round 17: one returned-day basis for every history range ----------

for (const range of ["month", "previous", "30days", "custom", "all"] as const) {
  test(`R17: ${range} totals and exported monthly records share the returned-day basis`, () => {
    const window = historyWindow(range, "2026-11-04", "2026-10");
    const source = ["2026-10", "2026-11"]
      .filter((month) => window.months.includes(month))
      .map((month) => ({
        month,
        fetchedAt: 0,
        sourceAsOfDate: "2026-11-04",
        usage: {
          ...usage(),
          rawModels: [
            usageModel(900, 90),
            {
              ...usageModel(800, 80),
              model: "second-model",
            },
            { ...usageModel(700, 70), model: "source-only-model" },
          ],
          days: [
            {
              date: `${month}-${month === "2026-10" ? "31" : "04"}`,
              rawModels: [
                usageModel(10, 1),
                {
                  ...usageModel(20, null),
                  model: "second-model",
                },
              ],
            },
          ],
        } as UsageResult,
      }));
    const snapshot = buildHistory(
      window,
      source,
      [],
      window.months.filter(
        (month) => !source.some((item) => item.month === month),
      ),
    );
    const page = returnedHistoryModels(snapshot);
    const exported = historyExport(snapshot, 0);
    const json = JSON.parse(exported.json);
    assert.equal(safeKnownSum(page, "totalTokens"), source.length * 30);
    assert.equal(safeKnownSum(page, "cost"), null);
    assert.equal(
      page.some((item) => item.model === "source-only-model"),
      false,
    );
    assert.equal(json.aggregationBasis, "returned-daily-records");
    assert.equal(
      safeKnownSum(
        json.monthly.flatMap(
          (item: { models: RawModelUsage[] }) => item.models,
        ),
        "totalTokens",
      ),
      safeKnownSum(page, "totalTokens"),
    );
    assert.equal(safeKnownSum(json.daily, "cost"), null);
    for (const item of json.monthly) {
      assert.equal(
        item.coveredDates,
        1,
        "multiple models are one returned date",
      );
      assert.equal(item.models.length, 2);
      assert.equal(item.aggregationBasis, "returned-daily-records");
      assert.equal(item.models[1].cost, null);
      assert.ok(item.missingDates.length > 0, "partial days remain explicit");
    }
    for (const item of json.sourceMonthlySnapshots) {
      assert.equal(item.models[0].totalTokens, 900);
      assert.equal(item.models[1].cost, 80);
      assert.equal(item.models[2].model, "source-only-model");
      assert.equal(item.sourceAsOfDate, "2026-11-04");
    }
    const csv = exported.csv
      .trim()
      .split("\r\n")
      .slice(1)
      .map((line) => line.slice(1, -1).split('","'));
    const returned = csv.filter((row) => row[11] === "returned");
    assert.equal(
      returned.reduce((total, row) => total + Number(row[3]), 0),
      source.length * 30,
    );
    assert.ok(
      returned.some((row) => row[9] === ""),
      "unknown costs stay blank",
    );
    const missing = csv.filter((row) => row[11] === "not-returned");
    assert.ok(missing.length > 0);
    assert.ok(
      missing.every((row) => row.slice(3, 10).every((cell) => cell === "")),
    );
  });
}

test("R17: a source-only month has no invented returned zero or daily total", () => {
  const snapshot = buildHistory(
    historyWindow("month", "2026-11-04"),
    [usageMonth("2026-11", 900, [])],
    [],
  );
  assert.deepEqual(returnedHistoryModels(snapshot), []);
  assert.equal(
    safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
    null,
  );
  const json = JSON.parse(historyExport(snapshot, 0).json);
  assert.deepEqual(json.monthly[0].models, []);
  assert.equal(json.sourceMonthlySnapshots[0].models[0].totalTokens, 900);
  assert.equal(json.missingDates.length, 4);
});

test("R17: advancing an all-history window retains batches, failures and source dates", () => {
  const window = historyWindow("all", "2026-10-31");
  const source = [
    usageMonth("2024-11", 10, [["2024-11-01", 10]]),
    {
      ...usageMonth("2026-10", 20, [["2026-10-31", 20]]),
      sourceAsOfDate: "2026-10-31",
    },
  ];
  const snapshot = buildHistory(
    window,
    source,
    ["2025-04"],
    window.months.slice(0, 58),
  );
  const next = retainHistoryWindow(
    snapshot,
    historyWindow("all", "2026-11-01"),
  );
  assert.deepEqual(next.months, source);
  assert.deepEqual(next.failedMonths, ["2025-04"]);
  assert.ok(next.unloadedMonths.includes("2026-11"));
  assert.equal(next.missingDates.includes("2026-11-01"), false);
  assert.equal(next.months[1].sourceAsOfDate, "2026-10-31");
  assert.equal(
    snapshot.window.to,
    "2026-10-31",
    "retention does not mutate the old snapshot",
  );
});

test("R17: rolling-window retention clips days and does not promote future placeholders", () => {
  const source = {
    ...usageMonth("2026-10", 90, [
      ["2026-10-04", 10],
      ["2026-10-05", 20],
      ["2026-10-06", 0],
    ]),
    sourceAsOfDate: "2026-10-05",
  };
  const snapshot = buildHistory(
    historyWindow("month", "2026-10-05"),
    [source],
    [],
  );
  const next = retainHistoryWindow(
    snapshot,
    historyWindow("month", "2026-10-06"),
  );
  assert.equal(next.rows.length, 2);
  assert.ok(next.missingDates.includes("2026-10-06"));
  const clipped = retainHistoryWindow(snapshot, {
    from: "2026-10-05",
    to: "2026-10-06",
    months: ["2026-10"],
  });
  assert.equal(safeKnownSum(returnedHistoryModels(clipped), "totalTokens"), 20);
});

test("R18: failed-only snapshots export failures without inventing data or unqueried missing dates", () => {
  const window = historyWindow("all", "2026-10-31");
  const failed = window.months.slice(-12);
  const unloaded = window.months.slice(0, -12);
  const snapshot = buildHistory(window, [], failed, unloaded);
  assert.deepEqual(snapshot.months, []);
  assert.deepEqual(snapshot.rows, []);
  assert.equal(
    safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
    null,
  );
  assert.deepEqual(snapshot.failedMonths, failed);
  assert.deepEqual(snapshot.unloadedMonths, unloaded);
  assert.ok(
    snapshot.missingDates.every((date) => failed.includes(date.slice(0, 7))),
  );
  const exported = historyExport(snapshot, 0, true);
  const json = JSON.parse(exported.json);
  assert.deepEqual(json.daily, []);
  assert.deepEqual(json.monthly, []);
  assert.deepEqual(json.sourceMonthlySnapshots, []);
  assert.deepEqual(json.failedMonths, failed);
  assert.deepEqual(json.unloadedMonths, unloaded);
  assert.equal(exported.csv.includes('"2020-01-01"'), false);
  const advanced = retainHistoryWindow(
    snapshot,
    historyWindow("all", "2026-11-01"),
  );
  assert.deepEqual(advanced.failedMonths, failed);
  assert.ok(advanced.unloadedMonths.includes("2026-11"));
  assert.equal(advanced.missingDates.includes("2026-11-01"), false);
});

// ---------- Round 29: canonical source dates before returned-day admission ----------

const dateWarning = "平台返回无效日期或查询月份以外的数据，请稍后刷新核对";

// Production retains anomalous dates and complete day fields/raw models. Its
// Rust payload does not supply accountingDate or unavailableDates, so the main
// regression must not depend on either optional frontend field rejecting them.
const productionHistoryDay = (
  date: string,
  tokens: number,
): UsageResult["days"][number] => ({
  date,
  rawModels: [usageModel(tokens)],
  flashTokens: tokens,
  flashCacheHit: 0,
  flashCacheMiss: 0,
  flashResponse: tokens,
  flashOtherTokens: 0,
  proTokens: 0,
  proCacheHit: 0,
  proCacheMiss: 0,
  proResponse: 0,
  proOtherTokens: 0,
  totalTokens: tokens,
  totalCost: 0,
});

const historyCsvRows = (csv: string): string[][] =>
  csv
    .trim()
    .split("\r\n")
    .map((line) =>
      Array.from(line.matchAll(/"((?:""|[^"])*)"(?:,|$)/g), (match) =>
        match[1].replace(/""/g, '"'),
      ),
    );

test("R29: dates must be exact Gregorian YYYY-MM-DD, never Date-normalized", () => {
  for (const date of [
    "2026-10-01",
    "2024-02-29",
    "2000-02-29",
    "2026-04-30",
    "2026-12-31",
  ])
    assert.equal(isHistoryDate(date), true, date);
  for (const date of [
    "2026-10-1",
    "2026-1-01",
    "2026-10-03x",
    "2026-10-03\n",
    "2026-10-03 ",
    " 2026-10-03",
    "2026-10-00",
    "2026-10-32",
    "2026-00-01",
    "2026-13-01",
    "2026-02-29",
    "2024-02-30",
    "2100-02-29",
    "2026-04-31",
    "2026-10-03T00:00:00Z",
    "",
  ])
    assert.equal(isHistoryDate(date), false, date);
  assert.deepEqual(historyDates("2024-02-28", "2024-03-01"), [
    "2024-02-28",
    "2024-02-29",
    "2024-03-01",
  ]);
  assert.throws(() => historyDates("2026-02-29", "2026-03-01"));
  assert.throws(() => historyWindow("month", "2026-04-31"));
});

for (const anomalousDate of ["2026-10-1", "2026-10-03x"]) {
  test(`R29: 31 real October days plus ${anomalousDate}=900 stay at 31 days and 310 Tokens`, () => {
    const validDates = historyDates("2026-10-01", "2026-10-31");
    const abnormalDay = productionHistoryDay(anomalousDate, 900);
    abnormalDay.rawModels![0] = Object.assign(
      { ...usageModel(900), dataWarning: "异常日的原始模型警告" },
      { token: "EXCLUDED_SECRET" },
    );
    const source = {
      month: "2026-10",
      fetchedAt: 0,
      sourceAsOfDate: "2026-11-05",
      usage: {
        ...usage(),
        rawModels: [usageModel(1210)],
        warnings: [dateWarning],
        days: [
          ...validDates.map((date) => productionHistoryDay(date, 10)),
          abnormalDay,
        ],
      },
    };
    const before = JSON.stringify(source);
    const snapshot = buildHistory(
      historyWindow("previous", "2026-11-05"),
      [source],
      [],
    );
    assert.equal(snapshot.rows.length, 31);
    assert.deepEqual(snapshot.missingDates, []);
    assert.equal(
      safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
      310,
    );
    assert.equal(
      safeKnownSum(returnedHistoryModels(snapshot, "2026-10"), "totalTokens"),
      310,
      "monthly trend and page totals share the admitted day rows",
    );
    const dailyTrend = historyDates(
      snapshot.window.from,
      snapshot.window.to,
    ).map((date) =>
      safeKnownSum(
        snapshot.rows
          .filter((row) => row.date === date)
          .map((row) => row.model),
        "totalTokens",
      ),
    );
    assert.equal(dailyTrend.length, 31);
    assert.ok(dailyTrend.every((value) => value === 10));
    assert.equal(snapshot.excludedDays.length, 1);
    assert.equal(snapshot.excludedDays[0].date, anomalousDate);
    assert.equal(snapshot.excludedDays[0].reason, "invalid-date");
    assert.equal(snapshot.excludedDays[0].models[0].totalTokens, 900);
    assert.deepEqual(snapshot.excludedDays[0].warnings, [dateWarning]);

    const exported = historyExport(snapshot, 0);
    assert.equal(exported.json.includes("EXCLUDED_SECRET"), false);
    assert.equal(exported.csv.includes("EXCLUDED_SECRET"), false);
    const json = JSON.parse(exported.json);
    assert.equal(json.daily.length, 31);
    assert.equal(json.monthly[0].coveredDates, 31);
    assert.equal(json.monthly[0].excludedDateRecordCount, 1);
    assert.equal(safeKnownSum(json.daily, "totalTokens"), 310);
    assert.equal(safeKnownSum(json.monthly[0].models, "totalTokens"), 310);
    assert.equal(json.sourceMonthlySnapshots[0].models[0].totalTokens, 1210);
    assert.deepEqual(json.monthly[0].warnings, [dateWarning]);
    assert.deepEqual(json.sourceMonthlySnapshots[0].warnings, [dateWarning]);
    const rejected = json.excludedDateRecords[0];
    assert.equal(rejected.date, anomalousDate, "raw date is not normalized");
    assert.equal(rejected.status, "excluded-invalid-date");
    assert.equal(rejected.includedInTotals, false);
    assert.equal(rejected.sourceMonth, "2026-10");
    assert.equal(rejected.sourceAsOfDate, "2026-11-05");
    assert.equal(rejected.accountingDate, null);
    assert.equal(rejected.models[0].totalTokens, 900);
    assert.equal(rejected.models[0].dataWarning, "异常日的原始模型警告");
    assert.deepEqual(rejected.warnings, [dateWarning]);

    const [header, ...csv] = historyCsvRows(exported.csv);
    const normal = csv.filter((row) => row[11] === "returned");
    assert.equal(normal.length, 31);
    assert.equal(
      normal.reduce((sum, row) => sum + Number(row[3]), 0),
      310,
    );
    assert.equal(
      csv.reduce((sum, row) => sum + Number(row[3]), 0),
      310,
    );
    const excluded = csv.filter((row) => row[11] === "excluded-invalid-date");
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0][0], anomalousDate);
    assert.ok(excluded[0].slice(3, 10).every((cell) => cell === ""));
    assert.equal(excluded[0][header.indexOf("source_month")], "2026-10");
    assert.deepEqual(JSON.parse(excluded[0][header.indexOf("warnings")]), [
      dateWarning,
    ]);
    assert.equal(
      JSON.parse(excluded[0][header.indexOf("excluded_models")])[0].totalTokens,
      900,
    );
    assert.equal(
      JSON.stringify(source),
      before,
      "source evidence stays unchanged",
    );
  });
}

test("R29: malformed dates cannot fill a missing real date or disappear behind source filters", () => {
  const source = {
    month: "2026-10",
    fetchedAt: 0,
    sourceAsOfDate: "2026-10-04",
    usage: {
      ...usage(),
      accountingDate: "2026-10-03",
      unavailableDates: ["2026-10-02", "2026-10-1"],
      // The frontend must also create its own visible exclusion evidence when
      // an older response has no backend warnings field.
      warnings: undefined,
      days: [
        productionHistoryDay("2026-10-1", 900),
        productionHistoryDay("2026-10-03x", 900),
        productionHistoryDay("2026-10-00", 900),
        productionHistoryDay("2026-10-32", 900),
        productionHistoryDay("2026-09-30", 900),
        productionHistoryDay("2026-11-01", 900),
        productionHistoryDay("2026-10-02", 10),
        productionHistoryDay("2026-10-03", 10),
        productionHistoryDay("2026-10-04", 0),
        productionHistoryDay("2026-10-05", 0),
      ],
    },
  };
  const snapshot = buildHistory(
    historyWindow("month", "2026-10-05"),
    [source],
    [],
  );
  assert.deepEqual(
    snapshot.rows.map((row) => row.date),
    ["2026-10-03"],
  );
  assert.deepEqual(snapshot.missingDates, [
    "2026-10-01",
    "2026-10-02",
    "2026-10-04",
    "2026-10-05",
  ]);
  assert.equal(snapshot.excludedDays.length, 6);
  assert.equal(snapshot.excludedDays[0].unavailable, true);
  assert.ok(snapshot.excludedDays.every((day) => day.message.length > 0));
  assert.deepEqual(
    snapshot.excludedDays
      .filter((day) => day.reason === "outside-query-month")
      .map((day) => day.date),
    ["2026-09-30", "2026-11-01"],
  );
  const json = JSON.parse(historyExport(snapshot, 0).json);
  assert.equal(json.monthly[0].coveredDates, 1);
  assert.equal(json.excludedDateRecords.length, 6);
  assert.equal(json.daily[0].totalTokens, 10);
  const retained = retainHistoryWindow(
    snapshot,
    historyWindow("month", "2026-10-06"),
  );
  assert.deepEqual(retained.excludedDays, snapshot.excludedDays);
  assert.deepEqual(retained.rows, snapshot.rows);
  assert.ok(retained.missingDates.includes("2026-10-06"));
});

test("R29: invalid leap and month-end dates are evidence only, legitimate leap days remain returned", () => {
  for (const [month, good, bad] of [
    ["2024-02", "2024-02-29", "2024-02-30"],
    ["2026-02", "2026-02-28", "2026-02-29"],
    ["2026-04", "2026-04-30", "2026-04-31"],
  ]) {
    const snapshot = buildHistory(
      historyWindow("custom", "2026-11-05", month),
      [
        {
          month,
          fetchedAt: 0,
          sourceAsOfDate: "2026-11-05",
          usage: {
            ...usage(),
            accountingDate: "2026-11-05",
            days: [
              productionHistoryDay(good, 10),
              productionHistoryDay(bad, 900),
            ],
          },
        },
      ],
      [],
    );
    assert.deepEqual(
      snapshot.rows.map((row) => row.date),
      [good],
    );
    assert.equal(snapshot.excludedDays[0].date, bad);
    assert.equal(snapshot.excludedDays[0].reason, "invalid-date");
    assert.equal(snapshot.missingDates.includes(bad), false);
    assert.equal(
      safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
      10,
    );
  }
});

test("R29: a source with only invalid dates remains unknown, not returned zero", () => {
  const source = {
    ...usageMonth("2026-10", 900, [["2026-10-1", 900]]),
    sourceAsOfDate: "2026-11-05",
  };
  const snapshot = buildHistory(
    historyWindow("previous", "2026-11-05"),
    [source],
    [],
  );
  assert.deepEqual(snapshot.rows, []);
  assert.equal(snapshot.missingDates.length, 31);
  assert.equal(
    safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
    null,
  );
  const json = JSON.parse(historyExport(snapshot, 0).json);
  assert.deepEqual(json.monthly[0].models, []);
  assert.equal(json.monthly[0].coveredDates, 0);
  assert.equal(json.excludedDateRecords[0].models[0].totalTokens, 900);
});

test("R29: valid zero, missing models, unavailable days and legacy source-date compatibility remain distinct", () => {
  const data = {
    ...usage(),
    days: [
      productionHistoryDay("2026-10-01", 0),
      { ...productionHistoryDay("2026-10-02", 10), unavailable: true },
      { ...productionHistoryDay("2026-10-03", 10), rawModels: [] },
      { ...productionHistoryDay("2026-10-04", 10), rawModels: undefined },
    ],
  };
  for (const sourceAsOfDate of [undefined, "", "2026-10-04"]) {
    const snapshot = buildHistory(
      historyWindow("month", "2026-10-04"),
      [{ month: "2026-10", fetchedAt: 0, sourceAsOfDate, usage: data }],
      [],
    );
    assert.deepEqual(
      snapshot.rows.map((row) => row.date),
      ["2026-10-01"],
    );
    assert.equal(
      safeKnownSum(returnedHistoryModels(snapshot), "totalTokens"),
      0,
    );
    assert.deepEqual(snapshot.excludedDays, []);
    assert.deepEqual(snapshot.missingDates, [
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
  }
  const legacy = buildHistory(
    historyWindow("month", "2026-10-04"),
    [
      {
        month: "2026-10",
        fetchedAt: 0,
        usage: {
          ...data,
          schemaVersion: undefined,
          rawModels: undefined,
          days: data.days.map((day) => ({ ...day, rawModels: undefined })),
        },
      },
    ],
    [],
  );
  assert.deepEqual(legacy.rows, []);
  assert.deepEqual(legacy.excludedDays, []);
  assert.equal(legacy.missingDates.length, 4);
  assert.equal(
    safeKnownSum(returnedHistoryModels(legacy), "totalTokens"),
    null,
  );
});

test("R29: excluded CSV dates still receive formula protection and JSON preserves raw source evidence", () => {
  const date = "=SUM(1,2)";
  const source = usageMonth("2026-10", 900, [[date, 900]]);
  const snapshot = buildHistory(
    historyWindow("previous", "2026-11-05"),
    [source],
    [],
  );
  const exported = historyExport(snapshot, 0);
  const csv = historyCsvRows(exported.csv).find(
    (row) => row[11] === "excluded-invalid-date",
  );
  assert.ok(csv);
  assert.equal(csv[0], `'${date}`);
  assert.equal(JSON.parse(exported.json).excludedDateRecords[0].date, date);
});
