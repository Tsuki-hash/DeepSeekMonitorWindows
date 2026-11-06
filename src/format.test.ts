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

const day = (date: string, totalTokens: number, totalCost = 0): UsageDay => ({
  ...emptyUsageDay(date),
  totalTokens,
  totalCost,
});

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
  assert.equal(result[5].unavailable, false);
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

test("recentUsageDays：接口没返回的日期补零", () => {
  const today = businessDate(FIXED_NOW);
  const yesterday = businessShift(FIXED_NOW, -1);
  const result = recentUsageDays([day(yesterday, 1000)], 7, [], FIXED_NOW);
  assert.equal(result[6].date, today);
  const filled = result.find((item) => item.date === yesterday);
  assert.equal(filled?.totalTokens, 1000);
  // 其余 6 天必须是零值，而不是 undefined
  for (const item of result) {
    if (item.date === yesterday) continue;
    assert.equal(item.totalTokens, 0);
    assert.equal(item.flashTokens, 0);
    assert.equal(item.totalCost, 0);
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
    ...emptyUsageDay("2026-09-11"),
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
    point.hit + point.miss + point.response + point.other,
    point.total,
  );
});

test("chartPointFromDay：all 在 totalTokens 缺失时退回分段和", () => {
  const sample: UsageDay = {
    ...emptyUsageDay("2026-09-11"),
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
    ...emptyUsageDay("2026-09-11"),
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
    ...emptyUsageDay("2026-09-11"),
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
    ...emptyUsageDay("2026-09-11"),
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
