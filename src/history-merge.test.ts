import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHistoryMonths } from "./history-merge.ts";
import type { HistoryMonth } from "./history.ts";
import type { UsageResult } from "./types.ts";

const month = (value: string, cost: number): HistoryMonth => ({
  month: value,
  fetchedAt: 1,
  usage: { models: [], days: [], monthCost: cost } as UsageResult,
});

const windowMonths = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];

test("只重试失败月份_保留此前成功月份与合计", () => {
  const previous = [month("2026-03", 30), month("2026-04", 40)];
  const result = mergeHistoryMonths({
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
