import { test } from "node:test";
import assert from "node:assert/strict";
import { sumUsageCounts } from "./usage-counts.ts";

test("R25：安全计数恰等 MAX_SAFE_INTEGER，真实零和空和仍为零", () => {
  assert.deepEqual(sumUsageCounts([2 ** 52, 2 ** 52 - 1, 0]), {
    total: Number.MAX_SAFE_INTEGER,
    issue: null,
  });
  for (const values of [[], [0], [0, 0]])
    assert.deepEqual(sumUsageCounts(values), { total: 0, issue: null });
});

test("R25：2^53+1 的精确和不能先舍入再当可信值，后加0不恢复", () => {
  const values = [2 ** 52, 2 ** 52 + 1, 0];
  assert.equal(BigInt(values[0]) + BigInt(values[1]), 9_007_199_254_740_993n);
  assert.deepEqual(sumUsageCounts(values), { total: null, issue: "unsafe" });
  assert.deepEqual(sumUsageCounts([...values].reverse()), {
    total: null,
    issue: "unsafe",
  });
  assert.deepEqual(sumUsageCounts([Number.MAX_SAFE_INTEGER, 1, 0]), {
    total: null,
    issue: "unsafe",
  });
});

test("R25：每项先校验，负数抵消、小数、NaN及Infinity不能成为已知计数", () => {
  for (const values of [[1, -1], [0.5, 0.5], [NaN], [Infinity], [2 ** 53]])
    assert.deepEqual(sumUsageCounts(values), { total: null, issue: "unsafe" });
});

test("R25：未知与零分开，未知不会掩盖其他已知项的超界", () => {
  assert.deepEqual(sumUsageCounts([0, null, 0, undefined]), {
    total: null,
    issue: "unknown",
  });
  assert.deepEqual(sumUsageCounts([null, 2 ** 52, 2 ** 52 + 1, 0]), {
    total: null,
    issue: "unsafe",
  });
});
