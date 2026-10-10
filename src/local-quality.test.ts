import { test } from "node:test";
import assert from "node:assert/strict";
import { localEvidence, qualitySummary } from "./local-quality.ts";
import type { LocalRow } from "./local-usage";
const row: LocalRow = {
  id: "one",
  tool: "opencode",
  sessionId: "session",
  projectKey: null,
  projectPath: null,
  model: "test",
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 130,
  messageCount: 1,
  timedOutputTokens: 20,
  timedDurationMs: 1000,
  firstActiveMs: null,
  lastActiveMs: null,
};
test("质量字段区分齐全缺失与不一致，不将零或齐全当成实测", () => {
  assert.deepEqual(localEvidence(row), {
    tokenAccuracy: "unclassified",
    tokenFields: "complete",
    timingCoverage: "matched",
  });
  assert.equal(
    localEvidence({ ...row, cacheRead: null }).tokenFields,
    "partial",
  );
  assert.equal(
    localEvidence({
      ...row,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalTokens: null,
    }).tokenFields,
    "missing",
  );
  assert.equal(
    localEvidence({ ...row, totalTokens: 120 }).tokenFields,
    "unverified",
  );
  assert.equal(
    localEvidence({
      ...row,
      input: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    }).tokenFields,
    "unverified",
  );
  assert.equal(
    localEvidence({
      ...row,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    }).tokenFields,
    "complete",
  );
});
test("耗时保留新合同部分或未核对，旧快照保守兼容，假匹配拒绝", () => {
  for (const status of ["partial", "unavailable", "unverified"] as const)
    assert.equal(
      localEvidence({ ...row, timingCoverage: status }).timingCoverage,
      status,
    );
  assert.equal(
    localEvidence({ ...row, timingCoverage: "matched", timedDurationMs: null })
      .timingCoverage,
    "unverified",
  );
  assert.equal(
    localEvidence({ ...row, timedDurationMs: 0 }).timingCoverage,
    "unavailable",
  );
  assert.equal(
    localEvidence({ ...row, timedDurationMs: null, timedOutputTokens: null })
      .timingCoverage,
    "unavailable",
  );
});
test("质量汇总按当前视图计数，空视图不会凭空有覆盖", () => {
  const summary = qualitySummary([
    row,
    { ...row, cacheRead: null, timingCoverage: "partial" },
    { ...row, totalTokens: 125, timingCoverage: "unverified" },
  ]);
  assert.equal(summary.rows, 3);
  assert.deepEqual(summary.fields, {
    complete: 1,
    partial: 1,
    missing: 0,
    unverified: 1,
  });
  assert.deepEqual(summary.timing, {
    matched: 1,
    partial: 1,
    unavailable: 0,
    unverified: 1,
  });
  assert.equal(qualitySummary([]).rows, 0);
});
