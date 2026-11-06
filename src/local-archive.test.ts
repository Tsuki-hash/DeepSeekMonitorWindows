import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveExport,
  archiveLocalRows,
  archiveSelectionLabel,
  archiveSourceLabel,
  localPeriodKey,
} from "./local-archive.ts";
import type { ArchiveEntry, ArchiveSummary } from "./local-archive";
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

test("N06 同label不同来源归档保留身份四元组，并与导出ID一致", () => {
  const first = {
    ...entry.rows[0],
    sourceId: `home-${"a".repeat(12)}b${"0".repeat(51)}`,
    sourceLabel: "WSL · Ubuntu",
    tool: "claude",
    clientId: "claude",
    projectLabel: "same",
    projectRef: null,
  };
  const second = {
    ...first,
    sourceId: `home-${"a".repeat(12)}c${"0".repeat(51)}`,
  };
  const saved: ArchiveEntry = { ...entry, scope: "all", rows: [first, second] };
  const label = archiveSelectionLabel(saved);
  assert.equal(label.split("；").length, 2);
  assert.equal(
    label,
    archiveSelectionLabel({ ...saved, rows: [second, first] }),
  );
  const full = archiveSelectionLabel(saved, [], true);
  assert.ok(full.includes(first.sourceId) && full.includes(second.sourceId));
  assert.ok(archiveSourceLabel(saved).includes("多个来源"));
  const data = archiveExport(saved);
  assert.deepEqual(
    JSON.parse(data.json).rows.map((row: { sourceId: string }) => row.sourceId),
    [first.sourceId, second.sourceId],
  );
  for (const id of [first.sourceId, second.sourceId])
    assert.ok(data.csv.includes(id));
  const twoTools = { ...saved, rows: [first, { ...first, tool: "opencode" }] };
  assert.equal(archiveSelectionLabel(twoTools).split("；").length, 2);
  const sameIdentity = {
    ...saved,
    rows: [first, { ...first, sourceLabel: "另一个显示名", model: "other" }],
  };
  assert.equal(archiveSelectionLabel(sameIdentity).split("；").length, 1);
});

test("N06 summary区分多源、唯一源与旧未知，不据同一来源文字猜测", () => {
  const { rows: _rows, ...metadata } = entry;
  const base: ArchiveSummary = {
    ...metadata,
    rowCount: 2,
    sourceLabel: "WSL · Ubuntu",
  };
  assert.equal(archiveSourceLabel(base), "多个来源或身份未知");
  assert.ok(
    archiveSourceLabel({
      ...base,
      sourceCount: 2,
      sourceIdentityStatus: "mixed",
    }).includes("多个来源"),
  );
  assert.ok(
    archiveSourceLabel({
      ...base,
      sourceCount: 1,
      sourceIdentityStatus: "mixed",
      sourceHasUnknown: true,
    }).includes("含未知身份"),
  );
  assert.equal(
    archiveSourceLabel({
      ...base,
      sourceCount: 0,
      sourceIdentityStatus: "unknown",
    }),
    "来源身份未知",
  );
  const sourceId = `home-${"f".repeat(64)}`;
  assert.ok(
    archiveSelectionLabel(
      {
        ...base,
        sourceId,
        sourceCount: 1,
        sourceIdentityStatus: "known",
        tool: "claude",
        clientId: "claude",
        sessionId: "same",
      },
      [],
      true,
    ).includes(sourceId),
  );
  // Short overviews can be bounded, but full source details and deletion checks must retain every identity.
  const many = {
    ...entry,
    rows: Array.from({ length: 7 }, (_, i) => ({
      ...entry.rows[0],
      sourceId: `home-${String(i).repeat(64)}`,
    })),
  };
  assert.ok(archiveSelectionLabel(many).includes("另 2 个"));
  const complete = archiveSelectionLabel(many, [], true);
  assert.equal(complete.split("；").length, 7);
  for (const row of many.rows) assert.ok(complete.includes(row.sourceId));
});

test("N06 归档与留存两种导出对旧非opaque来源ID失败关闭且不改写存储对象", () => {
  for (const sourceId of [
    "D:\\Private\\SECRET",
    "\\\\wsl$\\Ubuntu\\home\\SECRET",
    "sk-secret-SECRET",
    undefined,
  ]) {
    const old: ArchiveEntry = {
      ...entry,
      rows: [
        { ...entry.rows[0], sourceId, sourceLabel: "D:\\Private\\SECRET" },
      ],
    };
    for (const retained of [false, true]) {
      const data = archiveExport(old, retained);
      for (const text of [data.json, data.csv]) {
        assert.equal(text.includes("SECRET"), false);
        assert.equal(text.includes("Private"), false);
      }
      assert.equal(JSON.parse(data.json).rows[0].sourceId, "legacy-unknown");
      assert.equal(
        JSON.parse(data.json).rows[0].sourceLabel,
        "旧版来源身份未知",
      );
      assert.equal(old.rows[0].sourceId, sourceId);
    }
  }
});
