import { test } from "node:test";
import assert from "node:assert/strict";
import { historyDateLabel } from "./history-date-label.ts";

const short = (value: string) => {
  const parts = value.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
};

test("跨年区间显示完整日期_不同年份同月日不再混淆", () => {
  const from = "2025-01-01";
  const to = "2026-10-10";
  assert.equal(historyDateLabel("2025-01-01", from, to, short), "2025-01-01");
  assert.equal(historyDateLabel("2026-01-01", from, to, short), "2026-01-01");
  // 同一张表里两条 1/1 现在可区分。
  assert.notEqual(
    historyDateLabel("2025-01-01", from, to, short),
    historyDateLabel("2026-01-01", from, to, short),
  );
});

test("单年区间保持短格式_不额外加长表格", () => {
  assert.equal(
    historyDateLabel("2026-09-11", "2026-09-01", "2026-09-30", short),
    "9/11",
  );
});

test("全部历史（2020 起）必然跨年_一律完整日期", () => {
  assert.equal(
    historyDateLabel("2020-01-01", "2020-01-01", "2026-10-10", short),
    "2020-01-01",
  );
});
