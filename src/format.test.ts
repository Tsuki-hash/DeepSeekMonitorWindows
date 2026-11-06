// 前端纯函数的单测。
//
// 运行方式：`npm test` → `node --test --experimental-strip-types src/`。
// Node 22 内置类型剥离可直接 import .ts（前提：只用可擦除的 TS 语法，不用 enum / namespace），
// 因此整个前端测试链不需要任何 devDependency。
//
// 覆盖范围刻意只挑「算错了不容易被发现」的函数：跨月补零、单位换算阈值。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  accountingDateKey,
  chartPointFromDay,
  chartTotal,
  chartTotalStatus,
  hasReturnedUsageDay,
  missingUsageDates,
  currencySymbol,
  dateKey,
  emptyUsageDay,
  fmtInt,
  fmtMoney,
  fmtMoneyDisplay,
  fmtTokensShort,
  mmdd,
  nextLoadStateAfterError,
  previousMonth,
  recentUsageDays,
  todayStr,
  type UsageDay,
} from "./format.ts";

const returnedDay = (
  date: string,
  totalTokens = 0,
  totalCost = 0,
): UsageDay => ({
  date,
  flashTokens: totalTokens,
  flashCacheHit: 0,
  flashCacheMiss: 0,
  flashResponse: 0,
  proTokens: 0,
  proCacheHit: 0,
  proCacheMiss: 0,
  proResponse: 0,
  flashOtherTokens: 0,
  proOtherTokens: 0,
  totalTokens,
  totalCost,
  rawModels: [
    {
      model: "deepseek-flash",
      groupKey: "flash",
      totalTokens,
      requestCount: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      responseTokens: 0,
      otherTokens: 0,
      cost: totalCost,
    },
  ],
});
const day = returnedDay;

// ---------- fmtTokensShort ----------

test("fmtTokensShort：各档阈值", () => {
  assert.equal(fmtTokensShort(0), "0");
  assert.equal(fmtTokensShort(999), "999");
  assert.equal(fmtTokensShort(1000), "1.0K");
  assert.equal(fmtTokensShort(1234), "1.2K");
  assert.equal(fmtTokensShort(268400), "268.4K");
  assert.equal(fmtTokensShort(999499), "999.5K");
  // 关键边界：999500 不能输出 "1000.0K"（7 字符，比下一档还长）
  assert.equal(fmtTokensShort(999500), "1.0M");
  assert.equal(fmtTokensShort(1e6), "1.0M");
  assert.equal(fmtTokensShort(1234567), "1.2M");
  assert.equal(fmtTokensShort(99999999), "100.0M");
  // 1e8 起改用整百万，避免出现「100.0M」这种带小数的大数
  assert.equal(fmtTokensShort(1e8), "100M");
  assert.equal(fmtTokensShort(2.5e8), "250M");
  assert.equal(fmtTokensShort(1e9), "1.0B");
  assert.equal(fmtTokensShort(999_950_000), "1.0B");
  assert.equal(fmtTokensShort(1e12), "1.0T");
});

test("fmtTokensShort：输出长度可控（柱顶标签的硬约束）", () => {
  // 356px 宽、7 列布局下每列约 34px，10px 字号最多容得下 6 个字符。
  // 这条断言是柱顶数值不再被 ellipsis 裁掉的护栏。
  const samples = [
    0, 999, 1000, 9999, 99999, 999499, 999500, 1e6, 9.9e6, 99999999, 1e8, 9.9e8,
    1e9, 1e12,
  ];
  for (const value of samples) {
    assert.ok(
      fmtTokensShort(value).length <= 6,
      `${value} 格式化后长度 ${fmtTokensShort(value).length} 超过 6：${fmtTokensShort(value)}`,
    );
  }
});

test("fmtTokensShort：负数与小数不产生异常输出", () => {
  assert.equal(fmtTokensShort(-1), "-1");
  assert.equal(fmtTokensShort(0.4), "0");
});

// ---------- fmtInt / fmtMoney / currencySymbol ----------

test("fmtInt：千分位与四舍五入", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(1234), "1,234");
  assert.equal(fmtInt(1234567.6), "1,234,568");
  assert.equal(fmtInt(268400), "268,400");
});

test("fmtMoney：默认人民币，固定两位小数", () => {
  assert.equal(fmtMoney(0), "¥0.00");
  assert.equal(fmtMoney(12.345), "¥12.35");
  assert.equal(fmtMoney(12.3, "$"), "$12.30");
});

test("currencySymbol：USD 用美元符号，其余一律人民币", () => {
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("CNY"), "¥");
  assert.equal(currencySymbol(undefined), "¥");
  assert.equal(currencySymbol(""), "¥");
});

// ---------- 日期工具 ----------

test("dateKey：补零到两位，且不受时区偏移影响", () => {
  assert.equal(dateKey(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(dateKey(new Date(2026, 8, 11)), "2026-09-11");
  // 本地午夜不能因 toISOString 的 UTC 转换回退成前一天
  assert.equal(dateKey(new Date(2026, 8, 11, 0, 0, 0)), "2026-09-11");
  assert.equal(dateKey(new Date(2026, 8, 11, 23, 59, 59)), "2026-09-11");
});

test("todayStr：使用平台东八区记账日期", () => {
  assert.equal(todayStr(), accountingDateKey(new Date()));
  assert.equal(
    accountingDateKey(new Date("2026-09-30T16:00:00Z")),
    "2026-10-01",
  );
  assert.equal(
    accountingDateKey(new Date("2026-12-31T16:00:00Z")),
    "2027-01-01",
  );
});

test("recentUsageDays：未获取日期为未知，已获取无用量日期为零", () => {
  // 第五轮复评 N07：now 显式注入，期望以记账日定义，不依赖宿主时区。
  const result = recentUsageDays([], 7, [businessDate(FIXED_NOW)], FIXED_NOW);
  assert.equal(result[6].unavailable, true);
  assert.equal(chartPointFromDay(result[6]).unavailable, true);
  assert.equal(result[5].unavailable, true);
});

test("addDays：跨月与跨年", () => {
  assert.equal(dateKey(addDays(new Date(2026, 8, 11), -1)), "2026-09-10");
  assert.equal(dateKey(addDays(new Date(2026, 8, 1), -1)), "2026-08-31");
  assert.equal(dateKey(addDays(new Date(2026, 0, 1), -1)), "2025-12-31");
  assert.equal(dateKey(addDays(new Date(2025, 11, 31), 1)), "2026-01-01");
  // 不修改入参
  const base = new Date(2026, 8, 11);
  addDays(base, 5);
  assert.equal(dateKey(base), "2026-09-11");
});

test("mmdd：三段式日期转月/日，异常输入原样返回", () => {
  assert.equal(mmdd("2026-09-11"), "9/11");
  assert.equal(mmdd("2026-01-01"), "1/1");
  // 不补零到两位：柱状图下方标签空间紧张
  assert.equal(mmdd("bad"), "bad");
  assert.equal(mmdd("2026-09"), "2026-09");
});

test("previousMonth：跨年回退", () => {
  assert.deepEqual(previousMonth(new Date(2026, 8, 11)), {
    month: 8,
    year: 2026,
  });
  assert.deepEqual(previousMonth(new Date(2026, 0, 15)), {
    month: 12,
    year: 2025,
  });
  assert.deepEqual(previousMonth(new Date(2026, 11, 31)), {
    month: 11,
    year: 2026,
  });
});

// ---------- recentUsageDays ----------
//
// 第五轮复评 N07：产品按**东八区记账日**生成窗口，旧测试用宿主本地日构造
// 「昨天/明天」，本地日 ≠ 记账日时假红（UTC−7 实测 161 项挂 2 项）。
// 现在 now 显式注入，全部期望以记账日（UTC+8）定义，任何时区结果一致。
// 固定时刻用 UTC 绝对时间表达：
// - 2026-11-04T02:00:00Z → 北京 10:00，记账日 2026-11-04
// - 2026-11-04T15:59:59Z → 记账日仍是 2026-11-04（北京 23:59:59）
// - 2026-11-04T16:00:00Z → 记账日翻到 2026-11-05（北京次日零点）
const FIXED_NOW = new Date("2026-11-04T02:00:00Z");
const businessDate = (instant: Date) => accountingDateKey(instant);
const businessShift = (base: Date, days: number) =>
  accountingDateKey(new Date(base.getTime() + days * 86400_000));

test("recentUsageDays：固定返回 7 天且按时间升序", () => {
  const result = recentUsageDays([], 7, [], FIXED_NOW);
  assert.equal(result.length, 7);
  const dates = result.map((item) => item.date);
  assert.deepEqual(dates, [...dates].sort(), "应按日期升序排列");
  assert.equal(dates[6], businessDate(FIXED_NOW), "最后一天必须是记账日今天");
});

test("recentUsageDays：接口没返回的日期补为未知", () => {
  const today = businessDate(FIXED_NOW);
  const yesterday = businessShift(FIXED_NOW, -1);
  const result = recentUsageDays([day(yesterday, 1000)], 7, [], FIXED_NOW);
  assert.equal(result[6].date, today);
  const filled = result.find((item) => item.date === yesterday);
  assert.equal(filled?.totalTokens, 1000);
  // 其余 6 天没有源行，必须未知而不是零
  for (const item of result) {
    if (item.date === yesterday) continue;
    assert.equal(item.totalTokens, null);
    assert.equal(item.flashTokens, null);
    assert.equal(item.totalCost, null);
  }
});

test("recentUsageDays：跨月窗口能正确回溯到上月", () => {
  // 记账日 2026-04-01（北京 4 月 1 日 10 点）：窗口起点必然落在 3 月。
  // 这条是跨月补零逻辑的护栏：若改成「拿接口最后一天往前数」，这里会失败。
  const result = recentUsageDays([], 7, [], new Date("2026-04-01T02:00:00Z"));
  assert.equal(result[0].date, "2026-03-26");
  assert.equal(result[6].date, "2026-04-01");
  assert.equal(result[0].date < result[6].date, true, "窗口起点必须早于终点");
});

test("recentUsageDays：过滤掉未来日期的占位行", () => {
  const tomorrow = businessShift(FIXED_NOW, 1);
  const farFuture = businessShift(FIXED_NOW, 30);
  const result = recentUsageDays(
    [day(tomorrow, 999), day(farFuture, 888)],
    7,
    [],
    FIXED_NOW,
  );
  assert.equal(result.length, 7);
  assert.equal(
    result.some((item) => item.totalTokens === 999 || item.totalTokens === 888),
    false,
    "未来日期的数据不应出现在窗口里（接口月初会返回整月占位行）",
  );
});

test("recentUsageDays：自定义窗口长度", () => {
  assert.equal(recentUsageDays([], 1, [], FIXED_NOW).length, 1);
  assert.equal(recentUsageDays([], 30, [], FIXED_NOW).length, 30);
  assert.equal(
    recentUsageDays([], 30, [], FIXED_NOW)[29].date,
    businessDate(FIXED_NOW),
  );
});

test("recentUsageDays：同一天出现多条时取最后一条", () => {
  // Map 构造保证后者覆盖前者；这里锁定该行为，避免将来改成 reduce 时语义漂移
  const today = businessDate(FIXED_NOW);
  const result = recentUsageDays(
    [day(today, 100), day(today, 200)],
    7,
    [],
    FIXED_NOW,
  );
  assert.equal(result[6].totalTokens, 200);
});

test("recentUsageDays：不修改入参数组", () => {
  const input = [day("2026-09-01", 1)];
  const snapshot = JSON.stringify(input);
  recentUsageDays(input, 7, [], FIXED_NOW);
  assert.equal(JSON.stringify(input), snapshot);
});

test("recentUsageDays：UTC 15:59:59 与 16:00:00 的记账日翻转", () => {
  // 北京时间零点 = UTC 16:00。翻转瞬间整个窗口必须整体前移一天；
  // 期望是写死的绝对日期，宿主在任意时区（含夏令时）都必须一致。
  const before = new Date("2026-11-04T15:59:59Z");
  const after = new Date("2026-11-04T16:00:00Z");
  assert.equal(accountingDateKey(before), "2026-11-04");
  assert.equal(accountingDateKey(after), "2026-11-05");
  assert.equal(recentUsageDays([], 7, [], before)[6].date, "2026-11-04");
  assert.equal(recentUsageDays([], 7, [], after)[6].date, "2026-11-05");
});

test("recentUsageDays：月末、年末与闰日窗口", () => {
  // 月末：记账日 2026-04-01 → 起点 2026-03-26（跨 3/4 月）
  assert.equal(
    recentUsageDays([], 7, [], new Date("2026-04-01T02:00:00Z"))[0].date,
    "2026-03-26",
  );
  // 年末：记账日 2027-01-01 → 起点 2026-12-26（跨 2026/2027）
  const newYear = recentUsageDays([], 7, [], new Date("2027-01-01T02:00:00Z"));
  assert.equal(newYear[0].date, "2026-12-26");
  assert.equal(newYear[6].date, "2027-01-01");
  // 闰日：2028-02-29 当天，7 天窗口起点 2028-02-23
  const leap = recentUsageDays([], 7, [], new Date("2028-02-29T02:00:00Z"));
  assert.equal(leap[0].date, "2028-02-23");
  assert.equal(leap[6].date, "2028-02-29");
  // 闰日次日：起点回溯必须落在 2 月（2027 非闰年等价场景会错成 02-25）
  const afterLeap = recentUsageDays(
    [],
    7,
    [],
    new Date("2028-03-01T02:00:00Z"),
  );
  assert.equal(afterLeap[0].date, "2028-02-24");
  assert.equal(afterLeap[6].date, "2028-03-01");
});

// ---------- chartPointFromDay ----------

test("chartPointFromDay：all 用 totalTokens 吞掉未识别模型差额", () => {
  const sample: UsageDay = {
    ...returnedDay("2026-09-11"),
    flashCacheHit: 100,
    flashCacheMiss: 200,
    flashResponse: 50,
    proCacheHit: 10,
    // 分段和 = 360，totalTokens = 500 → 差额 140 进 other
    totalTokens: 500,
  };
  const point = chartPointFromDay(sample, "all");
  assert.equal(point.hit, 110);
  assert.equal(point.miss, 200);
  assert.equal(point.response, 50);
  assert.equal(point.other, 140);
  assert.equal(point.total, 500);
  assert.equal(
    point.hit! + point.miss! + point.response! + point.other!,
    point.total,
  );
});

test("chartPointFromDay：all 在合法 totalTokens 小于分段和时保留分段", () => {
  const sample: UsageDay = {
    ...returnedDay("2026-09-11"),
    flashCacheHit: 10,
    flashOtherTokens: 5,
    totalTokens: 0,
  };
  const point = chartPointFromDay(sample, "all");
  assert.equal(point.total, 15);
  assert.equal(point.other, 5);
});

test("nextLoadStateAfterError：silent 保留 ok，否则标 error/nokey", () => {
  assert.equal(nextLoadStateAfterError("ok", true, "网络失败"), "ok");
  assert.equal(nextLoadStateAfterError("ok", false, "网络失败"), "error");
  assert.equal(
    nextLoadStateAfterError("loading", true, "未配置用量 Token"),
    "nokey",
  );
  assert.equal(
    nextLoadStateAfterError("error", true, "未配置 API Key"),
    "nokey",
  );
});

test("chartPointFromDay：单模型不含未识别模型差额", () => {
  const sample: UsageDay = {
    ...returnedDay("2026-09-11"),
    flashCacheHit: 100,
    flashResponse: 20,
    proCacheMiss: 999,
    totalTokens: 5000,
  };
  const flash = chartPointFromDay(sample, "flash");
  assert.equal(flash.total, 120);
  assert.equal(flash.other, 0);
  const pro = chartPointFromDay(sample, "pro");
  assert.equal(pro.total, 999);
});

test("chartPointFromDay：other 档只含未接入模型量（合计 − flash − pro）", () => {
  const sample: UsageDay = {
    ...returnedDay("2026-09-11"),
    flashTokens: 100,
    flashCacheHit: 60,
    flashCacheMiss: 40,
    proTokens: 20,
    proResponse: 20,
    // 合计 150：flash 100 + pro 20 → 未接入模型 30，无分段明细
    totalTokens: 150,
  };
  const point = chartPointFromDay(sample, "other");
  assert.equal(point.hit, 0);
  assert.equal(point.miss, 0);
  assert.equal(point.response, 0);
  assert.equal(point.other, 30);
  assert.equal(point.total, 30);
});

test("chartPointFromDay：other 档在合计小于已知模型时夹到 0", () => {
  // 防御：接口口径异常时不应出现负数柱高
  const sample: UsageDay = {
    ...returnedDay("2026-09-11"),
    flashTokens: 100,
    totalTokens: 50,
  };
  const point = chartPointFromDay(sample, "other");
  assert.equal(point.other, 0);
  assert.equal(point.total, 0);
});

test("大额货币展示保持紧凑，普通金额保留分位与币种", () => {
  assert.equal(fmtMoneyDisplay(128.56), "¥128.56");
  assert.equal(fmtMoneyDisplay(9999.99, "$"), "$9999.99");
  assert.equal(fmtMoneyDisplay(12345678.9), "¥12.3M");
  assert.equal(fmtMoneyDisplay(1234567890123.45), "¥1.2T");
});

test("R14-06：11月10日仅返回9日，无 unavailableDates 也不能补实测零", () => {
  const now = new Date("2026-11-09T16:00:00Z");
  const source = [returnedDay("2026-11-09", 100, 0.5)];
  const days = recentUsageDays(source, 7, [], now);
  assert.equal(days[6].date, "2026-11-10");
  assert.deepEqual(days[6], emptyUsageDay("2026-11-10"));
  for (const scope of ["all", "flash", "pro", "other"] as const)
    assert.equal(chartPointFromDay(days[6], scope).unavailable, true);
  assert.equal(chartTotal(days.map((day) => chartPointFromDay(day))), null);
  assert.equal(source[0].totalTokens, 100);
});

test("R14-06：非空显式零与空 data、旧版聚合零严格区分", () => {
  const now = new Date("2026-11-10T02:00:00Z");
  const zero = returnedDay("2026-11-10");
  assert.equal(chartPointFromDay(zero).total, 0);
  assert.equal(Boolean(chartPointFromDay(zero).unavailable), false);
  assert.equal(chartTotal([chartPointFromDay(zero)]), 0);
  for (const rawModels of [[], undefined]) {
    const unknown = recentUsageDays([{ ...zero, rawModels }], 1, [], now)[0];
    assert.equal(unknown.totalTokens, null);
    assert.equal(unknown.totalCost, null);
    assert.equal(chartPointFromDay({ ...zero, rawModels }).unavailable, true);
  }
  assert.equal(
    chartPointFromDay({
      ...zero,
      rawModels: [{ ...zero.rawModels![0], totalTokens: null }],
    }).unavailable,
    true,
  );
});

test("R14-06：已返回行也不能覆盖请求失败和源快照未来日期", () => {
  const now = new Date("2026-11-01T02:00:00Z");
  const days = recentUsageDays(
    [
      returnedDay("2026-10-31"),
      returnedDay("2026-11-01"),
      returnedDay("2026-11-02"),
    ],
    7,
    ["2026-10-31"],
    now,
    "2026-10-31",
  );
  assert.equal(days[5].unavailable, true);
  assert.equal(days[6].unavailable, true);
  assert.equal(
    days.some((day) => day.date === "2026-11-02"),
    false,
  );
  const usage = {
    days,
    models: [],
    monthCost: 0,
    accountingDate: "2026-10-31",
  };
  assert.ok(missingUsageDates(usage, now).includes("2026-11-01"));
});

test("R14-08：HIT存在但MISS缺失时柱和近7日合计保持未知", () => {
  const partial = {
    ...returnedDay("2026-11-10", 100),
    flashCacheHit: 100,
    flashCacheMiss: null,
  };
  for (const scope of ["all", "flash"] as const) {
    const point = chartPointFromDay(partial, scope);
    assert.equal(point.unavailable, true);
    assert.equal(chartTotal([point]), null);
  }
});

test("R14-08：Pro未知不能污染完整Flash，all与差额other仍未知", () => {
  const completeFlash = returnedDay("2026-11-10", 100);
  completeFlash.flashCacheHit = 100;
  const partial: UsageDay = {
    ...completeFlash,
    rawModels: [
      completeFlash.rawModels![0],
      {
        ...completeFlash.rawModels![0],
        model: "deepseek-v4-pro",
        groupKey: "pro",
        totalTokens: null,
      },
    ],
    proCacheMiss: null,
    proTokens: null,
    totalTokens: null,
  };
  const flash = chartPointFromDay(partial, "flash");
  assert.equal(Boolean(flash.unavailable), false);
  assert.equal(flash.total, 100);
  for (const scope of ["all", "pro", "other"] as const)
    assert.equal(chartPointFromDay(partial, scope).unavailable, true);
});

const countedDay = (date: string, tokens: number): UsageDay => ({
  ...returnedDay(date, tokens),
  flashCacheHit: tokens,
  rawModels: [
    { ...returnedDay(date, tokens).rawModels![0], cacheHitTokens: tokens },
  ],
});

test("R25：跨月两天都合法，2^52 + (2^52+1) 近7日合计必须未知", () => {
  const now = new Date("2026-11-01T02:00:00Z");
  const source = [
    ...[26, 27, 28, 29, 30].map((date) => countedDay(`2026-10-${date}`, 0)),
    countedDay("2026-10-31", 2 ** 52),
    countedDay("2026-11-01", 2 ** 52 + 1),
  ];
  const before = JSON.stringify(source);
  const days = recentUsageDays(source, 7, [], now, "2026-11-01");
  const points = days.map((day) => chartPointFromDay(day));
  assert.ok(points.every((point) => !point.unavailable));
  assert.equal(points[5].total, 2 ** 52);
  assert.equal(points[6].total, 2 ** 52 + 1);
  assert.equal(chartTotal(points), null);
  assert.deepEqual(chartTotalStatus(points), { total: null, issue: "unsafe" });
  assert.deepEqual(
    missingUsageDates({ days, models: [], monthCost: 0 }, now),
    [],
  );
  assert.equal(
    JSON.stringify(source),
    before,
    "日期与原始分段不得被合计超界改写",
  );
});

test("R25：跨日恰等安全上界可显示，超界后加0与未知不能恢复有效合计", () => {
  const point = (tokens: number) =>
    chartPointFromDay(countedDay("2026-11-01", tokens));
  assert.equal(
    chartTotal([point(2 ** 52), point(2 ** 52 - 1), point(0)]),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    chartTotal([point(2 ** 52), point(2 ** 52 + 1), point(0)]),
    null,
  );
  assert.equal(
    chartTotal([
      point(0),
      chartPointFromDay(emptyUsageDay("2026-10-31")),
      point(0),
    ]),
    null,
  );
  for (const invalid of [-1, 0.5, NaN, Infinity, 2 ** 53])
    assert.equal(chartTotal([{ ...point(0), total: invalid }]), null);
});

test("R25：单柱各分段与槽位上界都需校验，不能只检查最终日总量", () => {
  for (const second of [2 ** 52 - 1, 2 ** 52 + 1]) {
    const safe = second === 2 ** 52 - 1;
    const sample: UsageDay = {
      ...countedDay("2026-11-01", 0),
      flashCacheHit: 2 ** 52,
      flashCacheMiss: second,
      flashTokens: safe ? Number.MAX_SAFE_INTEGER : null,
      totalTokens: safe ? Number.MAX_SAFE_INTEGER : null,
      rawModels: [
        {
          ...returnedDay("2026-11-01").rawModels![0],
          model: "deepseek-v4-flash",
          cacheHitTokens: 2 ** 52,
          totalTokens: 2 ** 52,
        },
        {
          ...returnedDay("2026-11-01").rawModels![0],
          model: "deepseek-flash",
          cacheMissTokens: second,
          totalTokens: second,
        },
      ],
    };
    const before = JSON.stringify(sample);
    for (const scope of ["all", "flash"] as const) {
      const point = chartPointFromDay(sample, scope);
      assert.equal(point.total, safe ? Number.MAX_SAFE_INTEGER : null);
      assert.equal(Boolean(point.unavailable), !safe);
      assert.equal(point.hit, 2 ** 52);
      assert.equal(point.miss, second);
      if (!safe) {
        assert.equal(point.countIssue, "unsafe");
        assert.ok(point.unavailableReason?.includes("超出安全整数"));
      }
    }
    const sibling = chartPointFromDay(sample, "pro");
    assert.equal(sibling.total, 0);
    assert.equal(Boolean(sibling.unavailable), false, "合法兄弟槽位不被污染");
    assert.equal(hasReturnedUsageDay(sample), true);
    assert.equal(JSON.stringify(sample), before);
  }
});

test("R25：即使可见分段全为零也必须尊重后端槽位 total 未知", () => {
  const sample = { ...countedDay("2026-11-01", 0), flashTokens: null };
  const point = chartPointFromDay(sample, "flash");
  assert.equal(point.total, null);
  assert.equal(point.unavailable, true);
  assert.equal(point.hit, 0, "真实已知零分段保留");
  assert.equal(point.countIssue, "unknown");
  assert.equal(chartPointFromDay(sample, "pro").total, 0);
});

test("R25：同一分段跨槽位超界为未知，其他安全分段仍保留", () => {
  const sample = {
    ...countedDay("2026-11-01", 0),
    flashCacheHit: 2 ** 52,
    proCacheHit: 2 ** 52 + 1,
    flashCacheMiss: 3,
  };
  const point = chartPointFromDay(sample);
  assert.equal(point.total, null);
  assert.equal(point.hit, null);
  assert.equal(point.miss, 3);
  assert.equal(point.countIssue, "unsafe");
});

// Mirrors build_usage_result's returned day: a model total covers categories
// actually returned, so HIT=100 + RESPONSE=0 can coexist with MISS=null.
const futureModelDay = (
  futureTotal: number | null = 50,
  flashMiss: number | null = null,
): UsageDay => ({
  ...returnedDay("2026-11-10", 100, 0.15),
  flashCacheHit: 100,
  flashCacheMiss: flashMiss,
  totalTokens: futureTotal == null ? null : 100 + futureTotal,
  rawModels: [
    {
      ...returnedDay("2026-11-10", 100, 0.1).rawModels![0],
      cacheHitTokens: 100,
      cacheMissTokens: flashMiss,
    },
    {
      ...returnedDay("2026-11-10").rawModels![0],
      model: "future-model",
      groupKey: null,
      totalTokens: futureTotal,
      cacheHitTokens: null,
      cacheMissTokens: null,
      responseTokens: futureTotal,
      cost: 0.05,
    },
  ],
});

test("R26：生产日形状缺MISS仍保留未知模型50，首页与other详情一致", () => {
  const sample = futureModelDay();
  const before = JSON.stringify(sample);
  const point = chartPointFromDay(sample);
  assert.equal(point.hit, 100);
  assert.equal(point.miss, null);
  assert.equal(point.response, 0);
  assert.equal(point.other, 50);
  assert.equal(point.total, null);
  assert.equal(point.unavailable, true);
  assert.equal(point.countIssue, "unknown");
  assert.equal(chartTotal([point]), null);
  assert.equal(chartPointFromDay(sample, "other").total, 50);
  assert.equal(chartPointFromDay(sample, "flash").other, 0);
  assert.equal(chartPointFromDay(sample, "pro").total, 0);
  assert.equal(hasReturnedUsageDay(sample), true);
  assert.deepEqual(
    missingUsageDates(
      { days: [sample], models: [], monthCost: 0.15 },
      new Date("2026-11-10T02:00:00Z"),
    ).includes(sample.date),
    false,
  );
  assert.equal(sample.totalTokens, 150);
  assert.equal(sample.totalCost, 0.15);
  assert.equal(JSON.stringify(sample), before);
});

test("R26：全部安全或缺段时未知模型与已知other只计一次，真实0保留", () => {
  for (const miss of [null, 0]) {
    for (const future of [0, 50]) {
      const sample = futureModelDay(future, miss);
      sample.flashOtherTokens = 3;
      sample.flashTokens = 103;
      sample.proOtherTokens = 4;
      sample.proResponse = 7;
      sample.proTokens = 11;
      sample.totalTokens = 114 + future;
      sample.rawModels![0].otherTokens = 3;
      sample.rawModels![0].totalTokens = 103;
      sample.rawModels!.push({
        ...returnedDay(sample.date).rawModels![0],
        model: "deepseek-v4-pro",
        groupKey: "pro",
        totalTokens: 11,
        responseTokens: 7,
        otherTokens: 4,
      });
      const point = chartPointFromDay(sample);
      assert.equal(point.other, 7 + future);
      assert.equal(point.total, miss == null ? null : 114 + future);
      assert.equal(point.response, 7);
      assert.equal(chartPointFromDay(sample, "flash").other, 3);
      assert.equal(chartPointFromDay(sample, "pro").total, 11);
      assert.equal(chartPointFromDay(sample, "pro").other, 4);
      assert.equal(chartPointFromDay(sample, "other").total, future);
    }
  }
  const zero = chartPointFromDay(futureModelDay(0));
  assert.equal(zero.other, 0, "明确返回的未知模型零不能被清成未知");
  assert.equal(zero.response, 0);
  assert.equal(zero.total, null, "缺失MISS不能因其他为零恢复确定合计");
});

test("R26：未知模型缺值、坏值与超界为未知，安全兄弟分段与槽位不受污染", () => {
  for (const invalid of [null, undefined, -1, 0.5, NaN, Infinity, 2 ** 53]) {
    const sample = futureModelDay(50, 0);
    sample.rawModels![1].totalTokens = invalid as number | null;
    const point = chartPointFromDay(sample);
    assert.equal(point.other, null);
    assert.equal(point.total, null);
    assert.equal(point.unavailable, true);
    assert.equal(point.countIssue, invalid == null ? "unknown" : "unsafe");
    assert.equal(point.hit, 100);
    assert.equal(point.miss, 0);
    assert.equal(point.response, 0);
    assert.equal(chartPointFromDay(sample, "flash").total, 100);
    assert.equal(chartPointFromDay(sample, "pro").total, 0);
  }
});

test("R26：多个未知组及已知other分别安全累加，MAX与超界1不混淆", () => {
  for (const last of [2 ** 52 - 1, 2 ** 52]) {
    const safe = last === 2 ** 52 - 1;
    const sample = futureModelDay(2 ** 52, 0);
    sample.flashCacheHit = 0;
    sample.flashTokens = 0;
    sample.rawModels![0].cacheHitTokens = 0;
    sample.rawModels![0].totalTokens = 0;
    sample.rawModels!.push({
      ...sample.rawModels![1],
      model: "another-future-model",
      groupKey: "future-group",
      totalTokens: last,
      responseTokens: last,
    });
    sample.totalTokens = safe ? Number.MAX_SAFE_INTEGER : null;
    for (const miss of [0, null]) {
      sample.flashCacheMiss = miss;
      sample.rawModels![0].cacheMissTokens = miss;
      const point = chartPointFromDay(sample);
      assert.equal(point.other, safe ? Number.MAX_SAFE_INTEGER : null);
      assert.equal(
        point.total,
        safe && miss === 0 ? Number.MAX_SAFE_INTEGER : null,
      );
      if (!safe) assert.equal(point.countIssue, "unsafe");
      assert.equal(chartPointFromDay(sample, "pro").total, 0);
    }
  }
  const combined = futureModelDay(Number.MAX_SAFE_INTEGER, 0);
  combined.flashCacheHit = 0;
  combined.flashOtherTokens = 1;
  combined.flashTokens = 1;
  combined.totalTokens = null;
  combined.rawModels![0].cacheHitTokens = 0;
  combined.rawModels![0].otherTokens = 1;
  combined.rawModels![0].totalTokens = 1;
  assert.equal(chartPointFromDay(combined).other, null);
  assert.equal(chartPointFromDay(combined).countIssue, "unsafe");
  assert.equal(chartPointFromDay(combined, "flash").total, 1);
});

test("R26：空raw、旧group形状与不可归属差额不能创造other零", () => {
  for (const rawModels of [undefined, []]) {
    const point = chartPointFromDay({ ...futureModelDay(), rawModels });
    assert.equal(point.other, null);
    assert.equal(point.total, null);
  }
  const legacy = futureModelDay(50, 0);
  delete (legacy.rawModels![1] as { groupKey?: string | null }).groupKey;
  assert.equal(chartPointFromDay(legacy).other, null);
  assert.equal(chartPointFromDay(legacy).total, null);
  const unassigned = futureModelDay();
  unassigned.rawModels = [unassigned.rawModels![0]];
  assert.equal(chartPointFromDay(unassigned).other, null);
  assert.equal(chartPointFromDay(unassigned).total, null);
  unassigned.flashCacheMiss = 0;
  assert.equal(chartPointFromDay(unassigned).other, 50);
  assert.equal(chartPointFromDay(unassigned).total, 150);
});

test("R26：缺MISS且总量仅因溢出未知时，已证明安全的other=7或0不得丢失", () => {
  for (const other of [0, 7]) {
    const sample: UsageDay = {
      ...returnedDay("2026-11-10"),
      flashTokens: null,
      flashCacheHit: Number.MAX_SAFE_INTEGER,
      flashCacheMiss: null,
      flashResponse: 1,
      flashOtherTokens: other,
      totalTokens: null,
      rawModels: [
        {
          ...returnedDay("2026-11-10").rawModels![0],
          totalTokens: null,
          cacheHitTokens: Number.MAX_SAFE_INTEGER,
          cacheMissTokens: null,
          responseTokens: 1,
          otherTokens: other,
        },
      ],
    };
    const point = chartPointFromDay(sample);
    assert.equal(point.other, other);
    assert.equal(point.hit, Number.MAX_SAFE_INTEGER);
    assert.equal(point.miss, null);
    assert.equal(point.response, 1);
    assert.equal(point.total, null);
    assert.equal(point.countIssue, "unsafe");
    assert.equal(chartPointFromDay(sample, "pro").total, 0);
  }
});
