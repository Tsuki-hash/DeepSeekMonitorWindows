import { test } from "node:test";
import assert from "node:assert/strict";
import { usageCompleteness, usageTrust } from "./usage-trust.ts";
import type { UsageResult } from "./types.ts";

const usage = (over: Partial<UsageResult> = {}): UsageResult => ({
  models: [],
  days: [],
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
