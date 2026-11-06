import { test } from "node:test";
import assert from "node:assert/strict";
import { localExport } from "./local-export.ts";
import {
  archiveExport,
  archiveIdentityLabel,
  archiveSelectionLabel,
} from "./local-archive.ts";
import { snapshotQuality, snapshotQualityLabel } from "./local-quality.ts";
import {
  localIdentity,
  localSessionLabel,
  localSessions,
} from "./local-usage.ts";
import type { LocalRow, LocalSnapshot } from "./local-usage";
import type { ArchiveEntry } from "./local-archive";
const row: LocalRow = {
  sourceId: "native",
  sourceLabel: "本机",
  id: "private-id",
  tool: "claude",
  clientId: "claude",
  sessionId: "same-session",
  model: "m",
  projectKey: null,
  projectPath: null,
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 30,
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
  periodKey: "2026-11",
  complete: true,
  rows: [row],
};
const entry: ArchiveEntry = {
  ...snapshot,
  periodKey: "2026-11",
  id: "a".repeat(64),
  savedAt: 2000,
  scope: "session",
  includesPaths: false,
  complete: true,
  stale: false,
  rows: [
    { ...row, projectRef: null, projectLabel: null, projectPath: undefined },
  ],
};
function csvRecord(csv: string) {
  const [header, first] = csv
    .trim()
    .replace(/^\ufeff/, "")
    .split("\r\n");
  const cells = (line: string) =>
    line.split(",").map((cell) => cell.replace(/^"|"$/g, ""));
  return Object.fromEntries(
    cells(header).map((name, index) => [name, cells(first)[index]]),
  );
}
for (const [name, evidence, recorded, warnings] of [
  ["legacy absent", {}, false, []],
  ["legacy empty", { qualityWarnings: [] }, false, []],
  [
    "new empty",
    { qualityEvidenceRecorded: true, qualityWarnings: [] },
    true,
    [],
  ],
  [
    "old known risk",
    { qualityWarnings: ["overlap_partial"] },
    true,
    ["overlap_partial"],
  ],
  [
    "new risk",
    { qualityEvidenceRecorded: true, qualityWarnings: ["overlap_partial"] },
    true,
    ["overlap_partial"],
  ],
  [
    "future code and duplicate",
    { qualityWarnings: ["future_risk", "overlap_partial", "future_risk"] },
    true,
    ["future_risk", "overlap_partial"],
  ],
  [
    "unsafe diagnostic",
    { qualityWarnings: ["D:\\Private\\SECRET", "overlap_partial"] },
    true,
    ["overlap_partial", "quality_warning_redacted"],
  ],
] as const) {
  test(`R02 ${name}: live/manual/retained JSON and CSV preserve equivalent evidence`, () => {
    const evidenceInput = {
      ...evidence,
      qualityWarnings:
        "qualityWarnings" in evidence
          ? [...evidence.qualityWarnings]
          : undefined,
    };
    for (const data of [
      localExport({ ...snapshot, ...evidenceInput }, [row], "session"),
      archiveExport({ ...entry, ...evidenceInput }),
      archiveExport({ ...entry, ...evidenceInput }, true),
    ]) {
      const json = JSON.parse(data.json);
      assert.equal(json.qualityEvidenceRecorded, recorded);
      assert.deepEqual(json.qualityWarnings, warnings);
      assert.equal(
        json.complete,
        true,
        "reading completeness does not erase quality risk",
      );
      const csv = csvRecord(data.csv);
      assert.equal(csv.qualityEvidenceRecorded, String(recorded));
      assert.equal(csv.qualityWarnings, warnings.join(";"));
      assert.equal(data.json.includes("SECRET"), false);
      assert.equal(data.csv.includes("Private"), false);
    }
  });
}
test("R02 quality labels distinguish unknown from recorded empty and preserve unknown codes", () => {
  assert.ok(snapshotQualityLabel({}).includes("未知"));
  assert.ok(
    snapshotQualityLabel({ qualityEvidenceRecorded: true }).includes(
      "未报告风险",
    ),
  );
  assert.ok(
    snapshotQualityLabel({ qualityWarnings: ["overlap_partial"] }).includes(
      "重复计入",
    ),
  );
  assert.ok(
    snapshotQualityLabel({ qualityWarnings: ["future_risk"] }).includes(
      "future_risk",
    ),
  );
  assert.deepEqual(
    snapshotQuality({ qualityWarnings: ["z", "a", "z"] }).qualityWarnings,
    ["a", "z"],
  );
});
test("R13 same-named clients and unknown historical clients have distinct keys, readable labels and exports", () => {
  const clients = [
    "claude",
    "claude-mirror",
    `cc-mirror:${"long-variant-".repeat(10)}`,
    undefined,
  ];
  const rows = clients.map((clientId) => ({ ...row, clientId }));
  const groups = localSessions(rows);
  assert.equal(groups.length, 4);
  assert.equal(new Set(rows.map(localSessionLabel)).size, 4);
  for (const current of rows) {
    const saved = {
      ...entry,
      rows: [{ ...entry.rows[0], clientId: current.clientId }],
    };
    const label = archiveSelectionLabel(saved);
    assert.ok(label.includes("本机") && label.includes("same-session"));
    assert.ok(label.includes(current.clientId || "旧版身份未知"));
    assert.ok(
      archiveIdentityLabel(saved).includes(current.clientId || "旧版身份未知"),
    );
    const exported = JSON.parse(archiveExport(saved).json);
    assert.equal(
      exported.rows[0].clientId,
      current.clientId || "legacy-unknown",
    );
  }
  assert.equal(localIdentity(rows).identityStatus, "mixed");
  assert.equal(
    localIdentity([{ clientId: undefined }]).identityStatus,
    "unknown",
  );
  assert.equal(
    archiveIdentityLabel({
      ...entry,
      rows: [...entry.rows, { ...entry.rows[0], clientId: "claude-mirror" }],
    }),
    "多个客户端（混合身份）",
  );
  assert.equal(
    JSON.parse(
      localExport(snapshot, [{ ...row, clientId: undefined }], "all").json,
    ).records[0].clientId,
    "legacy-unknown",
  );
});

test("R02 empty live CSV still carries snapshot-level evidence", () => {
  for (const evidence of [
    {},
    { qualityEvidenceRecorded: true },
    { qualityWarnings: ["overlap_partial"] },
  ]) {
    const data = localExport({ ...snapshot, ...evidence, rows: [] }, [], "all");
    const csv = csvRecord(data.csv);
    const json = JSON.parse(data.json);
    assert.equal(
      csv.qualityEvidenceRecorded,
      String(json.qualityEvidenceRecorded),
    );
    assert.equal(csv.qualityWarnings, json.qualityWarnings.join(";"));
    assert.deepEqual(json.records, []);
  }
});
