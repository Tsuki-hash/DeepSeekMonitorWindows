import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveExport,
  archiveLocalRows,
  localPeriodKey,
} from "./local-archive.ts";
import type { ArchiveEntry } from "./local-archive";
const entry: ArchiveEntry = {
  id: "a".repeat(64),
  collectedAt: 1000,
  savedAt: 2000,
  periodKey: "2026-10",
  engineVersion: "pinned",
  scope: "session",
  includesPaths: false,
  complete: false,
  stale: true,
  rows: [
    {
      sourceId: "native",
      sourceLabel: "本机",
      tool: "opencode",
      sessionId: "s1",
      model: "=SUM(1,2)",
      projectRef: "b".repeat(64),
      projectLabel: "Repo",
      input: 10,
      output: 20,
      cacheRead: null,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: null,
      messageCount: 1,
      timedOutputTokens: null,
      timedDurationMs: null,
      firstActiveMs: null,
      lastActiveMs: null,
      tokenAccuracy: "unclassified",
      timingCoverage: "partial",
    },
  ],
};
test("归档两种导出均按白名单排除私密字段、默认完整路径和伪实测标签", () => {
  const injected = {
    ...entry,
    prompt: "SECRET",
    rows: [
      {
        ...entry.rows[0],
        projectPath: "D:\\Private\\Repo",
        id: "SECRET",
        apiKey: "SECRET",
        tokenAccuracy: "measured",
      },
    ],
  };
  const data = archiveExport(injected as unknown as ArchiveEntry);
  for (const value of [data.json, data.csv]) {
    assert.equal(value.includes("SECRET"), false);
    assert.equal(value.includes("Private"), false);
    assert.equal(value.includes("measured"), false);
    assert.ok(value.includes("unclassified"));
  }
  const parsed = JSON.parse(data.json);
  assert.equal(parsed.rows[0].totalTokens, null);
  assert.equal(parsed.rows[0].projectPath, undefined);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.stale, true);
  assert.equal(parsed.periodKey, "2026-10");
  assert.ok(data.csv.startsWith("\ufeff"));
  assert.ok(data.csv.includes("'=SUM(1,2)"));
});
test("归档只有保存时已选择的完整路径能够导出", () => {
  const data = archiveExport({
    ...entry,
    includesPaths: true,
    rows: [{ ...entry.rows[0], projectPath: "D:\\Private\\Repo" }],
  });
  assert.equal(JSON.parse(data.json).rows[0].projectPath, "D:\\Private\\Repo");
  assert.ok(data.csv.includes("Private"));
});
test("会话留存导出明确区分自动检查点与手动快照", () => {
  const manual = archiveExport(entry),
    automatic = archiveExport(entry, true);
  assert.equal(JSON.parse(manual.json).captureKind, "manual-snapshot");
  assert.equal(
    JSON.parse(automatic.json).captureKind,
    "automatic-session-checkpoint",
  );
  assert.ok(automatic.csv.includes("automatic-session-checkpoint"));
  assert.equal(JSON.parse(automatic.json).rows[0].projectPath, undefined);
});
test("归档质量视图使用不透明项目标识并保留未知计数，月份采用电脑本地日期", () => {
  const rows = archiveLocalRows(entry);
  assert.equal(rows[0].projectKey, entry.rows[0].projectRef);
  assert.equal(rows[0].projectPath, null);
  assert.equal(rows[0].totalTokens, null);
  assert.equal(rows[0].timingCoverage, "partial");
  assert.equal(
    localPeriodKey(new Date(2026, 9, 31, 23, 59).getTime()),
    "2026-10",
  );
  assert.equal(
    localPeriodKey(new Date(2026, 10, 1, 0, 0).getTime()),
    "2026-11",
  );
});
