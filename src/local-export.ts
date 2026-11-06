import { csvCell } from "./history.ts";
import type { LocalRow, LocalSnapshot } from "./local-usage";
import { localEvidence, snapshotQuality } from "./local-quality.ts";
const fields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
  "messageCount",
  "timedOutputTokens",
  "timedDurationMs",
  "firstActiveMs",
  "lastActiveMs",
] as const;
export function localExport(
  snapshot: LocalSnapshot,
  rows: LocalRow[],
  scope: "all" | "project" | "session",
  includePaths = false,
  stale = false,
  generatedAt = Date.now(),
) {
  const projects = new Map<string, string>();
  const records = rows.map((row) => {
    const key = row.projectKey || "unassigned";
    if (!projects.has(key)) projects.set(key, `project-${projects.size + 1}`);
    return {
      sourceId: row.sourceId || "native",
      sourceLabel: row.sourceLabel || "本机",
      tool: row.tool,
      // 复评 N01：导出保留 client 身份，避免镜像与原生会话在导出中不可区分。
      clientId: row.clientId || "legacy-unknown",
      sessionId: row.sessionId,
      model: row.model,
      ...localEvidence(row),
      projectRef: row.projectKey ? projects.get(key) : null,
      projectLabel: row.projectPath
        ? row.projectPath
            .replace(/\\/g, "/")
            .replace(/\/$/, "")
            .split("/")
            .pop()
        : null,
      ...(includePaths ? { projectPath: row.projectPath } : {}),
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          typeof row[field] === "number" && Number.isFinite(row[field])
            ? row[field]
            : null,
        ]),
      ),
    };
  });
  const metadata = {
    schemaVersion: 2,
    source: "local-agent-usage",
    period: snapshot.period,
    periodKey:
      snapshot.periodKey && /^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot.periodKey)
        ? snapshot.periodKey
        : null,
    accountingUtcOffsetSeconds:
      typeof snapshot.accountingUtcOffsetSeconds === "number" &&
      Number.isInteger(snapshot.accountingUtcOffsetSeconds) &&
      Math.abs(snapshot.accountingUtcOffsetSeconds) < 86400
        ? snapshot.accountingUtcOffsetSeconds
        : null,
    scope,
    engineVersion: snapshot.engineVersion,
    collectedAt: new Date(snapshot.collectedAt).toISOString(),
    generatedAt: new Date(generatedAt).toISOString(),
    stale,
    complete: snapshot.complete !== false,
    ...snapshotQuality(snapshot),
    sources: (snapshot.sources || []).map((source) => ({
      id: source.id,
      label: source.label,
      state: source.state,
    })),
    includesPaths: includePaths,
    measurement: "source-dependent; may include token estimates",
    billing: "not matched to platform account; not billing evidence",
  };
  const header = [
    "sourceId",
    "sourceLabel",
    "tool",
    "clientId",
    "sessionId",
    "model",
    "tokenAccuracy",
    "tokenFields",
    "timingCoverage",
    "projectRef",
    "projectLabel",
    ...(includePaths ? ["projectPath"] : []),
    ...fields,
  ];
  return {
    json: JSON.stringify({ ...metadata, records }, null, 2),
    csv:
      "\uFEFF" +
      [
        [
          ...header,
          "source",
          "period",
          "periodKey",
          "accountingUtcOffsetSeconds",
          "scope",
          "collectedAt",
          "stale",
          "complete",
          "qualityEvidenceRecorded",
          "qualityWarnings",
          "measurement",
        ],
        // Empty snapshots still need a metadata row to preserve unknown/clean/risk.
        ...(records.length ? records : [null]).map((row) => [
          ...header.map((field) =>
            row ? (row as Record<string, unknown>)[field] : null,
          ),
          metadata.source,
          metadata.period,
          metadata.periodKey,
          metadata.accountingUtcOffsetSeconds,
          scope,
          metadata.collectedAt,
          stale,
          metadata.complete,
          metadata.qualityEvidenceRecorded,
          metadata.qualityWarnings.join(";"),
          metadata.measurement,
        ]),
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n") +
      "\r\n",
  };
}
