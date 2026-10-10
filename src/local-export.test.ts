import { test } from "node:test";
import assert from "node:assert/strict";
import { localExport } from "./local-export.ts";
import type { LocalRow, LocalSnapshot } from "./local-usage";
const row: LocalRow = {
  id: "D:\\Private\\Repo\0secret-id",
  tool: "opencode",
  sessionId: "session-one",
  projectKey: "d:/private/repo",
  projectPath: "D:\\Private\\Repo",
  model: "=SUM(1,2)",
  input: 100,
  output: 20,
  cacheRead: null,
  cacheWrite: 0,
  reasoning: 5,
  totalTokens: null,
  messageCount: 1,
  timedOutputTokens: null,
  timedDurationMs: null,
  firstActiveMs: null,
  lastActiveMs: null,
};
const snapshot: LocalSnapshot = {
  collectedAt: 1000,
  engineVersion: "pinned",
  period: "month",
  rows: [row],
};
test("跨月导出保留采集时月份与UTC偏移，之后的导出日期不改变统计范围", () => {
  for (const [periodKey, offset] of [
    ["2026-10", 28800],
    ["2026-09", -25200],
  ] as const) {
    const source = {
      ...snapshot,
      collectedAt: Date.parse("2026-09-30T16:01:00Z"),
      periodKey,
      accountingUtcOffsetSeconds: offset,
    };
    const data = localExport(
      source,
      [{ ...row, model: "deepseek" }],
      "all",
      false,
      false,
      Date.parse("2026-11-02T00:00:00Z"),
    );
    const json = JSON.parse(data.json);
    assert.equal(json.periodKey, periodKey);
    assert.equal(json.accountingUtcOffsetSeconds, offset);
    const csv = data.csv
      .split("\r\n")
      .map((line) =>
        line.split(",").map((cell) => cell.replace(/^\ufeff?"|"$/g, "")),
      );
    assert.equal(csv[1][csv[0].indexOf("periodKey")], periodKey);
    assert.equal(
      csv[1][csv[0].indexOf("accountingUtcOffsetSeconds")].replace(/^'/, ""),
      String(offset),
    );
  }
  const legacy = JSON.parse(localExport(snapshot, [row], "all").json);
  assert.equal(legacy.periodKey, null);
  assert.equal(legacy.accountingUtcOffsetSeconds, null);
});
test("质量导出保持未标定，保留字段及耗时状态，不能注入实测标签或路径", () => {
  const injected = Object.assign(
    { ...row, timingCoverage: "partial" as const },
    { tokenAccuracy: "measured", privatePath: "SECRET" },
  );
  const data = localExport(snapshot, [injected], "all");
  const record = JSON.parse(data.json).records[0];
  assert.equal(record.tokenAccuracy, "unclassified");
  assert.equal(record.tokenFields, "partial");
  assert.equal(record.timingCoverage, "partial");
  assert.equal(data.json.includes("SECRET"), false);
  assert.ok(
    data.csv
      .split("\r\n")[0]
      .replace(/"/g, "")
      .includes("tokenAccuracy,tokenFields,timingCoverage"),
  );
});
test("本地导出白名单默认不含完整路径或内部ID，保留未知和来源口径", () => {
  const extra = Object.assign(
    { ...row },
    { apiKey: "SECRET", prompt: "SECRET", title: "SECRET" },
  );
  const result = localExport(snapshot, [extra], "session", false, true, 2000);
  assert.equal(result.json.includes("SECRET"), false);
  assert.equal(result.json.includes("Private"), false);
  assert.equal(result.json.includes("secret-id"), false);
  const parsed = JSON.parse(result.json);
  assert.equal(parsed.records[0].projectLabel, "Repo");
  assert.equal(parsed.records[0].cacheRead, null);
  assert.equal(parsed.stale, true);
  assert.equal(parsed.scope, "session");
  assert.ok(result.csv.startsWith("\ufeff"));
  assert.ok(result.csv.includes("'=SUM(1,2)"));
  assert.ok(result.csv.includes("source-dependent"));
});
test("完整项目路径需要显式开启，导出只含选中视图的记录", () => {
  const result = JSON.parse(
    localExport(
      { ...snapshot, rows: [row, { ...row, sessionId: "not-selected" }] },
      [row],
      "project",
      true,
      false,
      2000,
    ).json,
  );
  assert.equal(result.includesPaths, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].projectPath, row.projectPath);
});
test("多来源导出标记不完整，来源状态不带主目录或错误信息", () => {
  const result = localExport(
    {
      ...snapshot,
      complete: false,
      sources: [
        {
          id: "home-hash",
          label: "目录1",
          state: "unavailable",
          message: "SECRET D:\\Private",
        },
      ],
    },
    [{ ...row, sourceId: "home-hash", sourceLabel: "目录1" }],
    "all",
  );
  const data = JSON.parse(result.json);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.complete, false);
  assert.equal(data.records[0].sourceId, "home-hash");
  assert.equal(data.records[0].projectPath, undefined);
  assert.equal(result.json.includes("SECRET"), false);
  assert.ok(result.csv.includes('"complete"'));
});
