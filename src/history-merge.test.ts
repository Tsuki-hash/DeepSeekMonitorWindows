import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHistoryMonths, sameScope } from "./history-merge.ts";
import type { HistoryScope } from "./history-merge.ts";
import type { HistoryMonth } from "./history.ts";
import type { UsageResult } from "./types.ts";

const month = (value: string, cost: number): HistoryMonth => ({
  month: value,
  fetchedAt: 1,
  usage: { models: [], days: [], monthCost: cost } as UsageResult,
});

const scope = (over: Partial<HistoryScope> = {}): HistoryScope => ({
  range: "all",
  from: "2026-01-01",
  to: "2026-05-31",
  epoch: 1,
  ...over,
});

const windowMonths = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];

test("只重试失败月份_保留此前成功月份与合计", () => {
  const previous = [month("2026-03", 30), month("2026-04", 40)];
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: scope(),
    previousFailed: [],
    windowMonths,
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous,
    failed: [],
  });
  assert.deepEqual(
    result.months.map((item) => item.month),
    ["2026-03", "2026-04", "2026-05"],
  );
  // 合计仍是三份，而不是只剩重试那一份。
  assert.equal(
    result.months.reduce((sum, item) => sum + (item.usage.monthCost ?? 0), 0),
    120,
  );
});

test("重试成功后覆盖同名月份_不重复累计", () => {
  const previous = [month("2026-05", 5), month("2026-04", 40)];
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: null,
    previousFailed: [],
    windowMonths,
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous,
    failed: [],
  });
  const may = result.months.filter((item) => item.month === "2026-05");
  assert.equal(may.length, 1);
  assert.equal(may[0].usage.monthCost, 50);
});

test("提前停止时未尝试月份必须算未加载_不能当成平台未返回", () => {
  // 计划 12 个月，第二个月遇 429 停止：只尝试了 2 个，其余必须 unloaded。
  const planned = windowMonths;
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: null,
    previousFailed: [],
    windowMonths,
    planned,
    attempted: ["2026-04", "2026-03"],
    successful: [month("2026-04", 40)],
    previous: [],
    failed: ["2026-03"],
  });
  assert.deepEqual(result.unloaded, ["2026-01", "2026-02"]);
  // 失败月份本身既不是未加载，也不是「未返回」的已覆盖范围。
  assert.equal(result.unloaded.includes("2026-03"), false);
  assert.equal(result.coveredFrom, "2026-04");
});

test("首次批次半途停止后_继续加载能发出更早月份请求", () => {
  const first = mergeHistoryMonths({
    scope: scope(),
    previousScope: null,
    previousFailed: [],
    windowMonths,
    planned: windowMonths,
    attempted: ["2026-05", "2026-04"],
    successful: [month("2026-05", 50)],
    previous: [],
    failed: ["2026-04"],
  });
  assert.equal(first.coveredFrom, "2026-05");
  // 未加载里应当包含比 2026-05 更早的月份，供「继续加载」使用。
  assert.ok(first.unloaded.includes("2026-03"));
  assert.ok(first.unloaded.length > 0);
});

test("没有任何成功数据时_整个窗口都算未加载", () => {
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: null,
    previousFailed: [],
    windowMonths,
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [],
    previous: [],
    failed: ["2026-05"],
  });
  assert.equal(result.coveredFrom, null);
  assert.equal(result.unloaded.length, windowMonths.length - 1);
});

test("结果按月份升序且按月去重", () => {
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: scope(),
    previousFailed: [],
    windowMonths,
    planned: windowMonths,
    attempted: windowMonths,
    successful: [month("2026-02", 20), month("2026-01", 10)],
    previous: [month("2026-02", 99)],
    failed: [],
  });
  assert.deepEqual(
    result.months.map((item) => item.month),
    ["2026-01", "2026-02"],
  );
  assert.equal(result.months[1].usage.monthCost, 20);
});

// ---------- R02：作用域隔离 ----------

test("切范围后不继承旧月份_窗口外数据不得混入", () => {
  const previous = [month("2026-03", 30)];
  const result = mergeHistoryMonths({
    previousFailed: [],
    scope: scope({ range: "month", from: "2026-05-01", to: "2026-05-31" }),
    previousScope: scope(),
    windowMonths: ["2026-05"],
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous,
    failed: [],
  });
  assert.deepEqual(
    result.months.map((item) => item.month),
    ["2026-05"],
    "上个月份不得进入本月汇总",
  );
});

test("换账户（epoch 变化）不继承旧月份_账户数据不串", () => {
  const result = mergeHistoryMonths({
    previousFailed: [],
    scope: scope({ epoch: 2 }),
    previousScope: scope({ epoch: 1 }),
    windowMonths,
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous: [month("2026-04", 40)],
    failed: [],
  });
  assert.deepEqual(
    result.months.map((item) => item.month),
    ["2026-05"],
    "旧账户月份不得残留",
  );
});

test("同作用域但窗口外的旧月份仍被防御性过滤", () => {
  const result = mergeHistoryMonths({
    previousFailed: [],
    scope: scope(),
    previousScope: scope(),
    windowMonths: ["2026-05"],
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous: [month("2026-01", 10)],
    failed: [],
  });
  assert.deepEqual(
    result.months.map((item) => item.month),
    ["2026-05"],
  );
});

test("作用域比较覆盖区间、窗口与代际", () => {
  assert.equal(sameScope(scope(), scope()), true);
  assert.equal(sameScope(scope(), scope({ range: "month" })), false);
  assert.equal(sameScope(scope(), scope({ from: "2026-02-01" })), false);
  assert.equal(sameScope(scope(), scope({ epoch: 2 })), false);
});

// ---------- R05：失败月份跨批次持久 ----------

test("继续加载成功后_前批失败月份仍可重试", () => {
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: scope(),
    previousFailed: ["2026-04"],
    windowMonths,
    planned: ["2026-01", "2026-02"],
    attempted: ["2026-01", "2026-02"],
    successful: [month("2026-01", 10), month("2026-02", 20)],
    previous: [month("2026-03", 30), month("2026-05", 50)],
    failed: [],
  });
  assert.deepEqual(
    result.failedMonths,
    ["2026-04"],
    "前批失败月份不得因新批次成功而消失",
  );
});

test("重试成功后只清除对应月份的失败", () => {
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: scope(),
    previousFailed: ["2026-03", "2026-04"],
    windowMonths,
    planned: ["2026-04"],
    attempted: ["2026-04"],
    successful: [month("2026-04", 40)],
    previous: [month("2026-03", 30)],
    failed: [],
  });
  assert.deepEqual(result.failedMonths, ["2026-03"], "只清除本次成功的月份");
});

test("窗口外的旧失败记录被清理", () => {
  const result = mergeHistoryMonths({
    scope: scope(),
    previousScope: scope(),
    previousFailed: ["2026-01"],
    windowMonths: ["2026-05"],
    planned: ["2026-05"],
    attempted: ["2026-05"],
    successful: [month("2026-05", 50)],
    previous: [],
    failed: [],
  });
  assert.deepEqual(result.failedMonths, []);
});
