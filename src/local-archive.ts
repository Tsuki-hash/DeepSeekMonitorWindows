import { localClientLabel, localIdentity } from "./local-usage.ts";
import type { ClientIdentityStatus } from "./local-usage";
import { snapshotQuality } from "./local-quality.ts";
import type { LocalRow } from "./local-usage";
import { csvCell } from "./history.ts";
export type ArchiveScope =
  | { kind: "all" }
  | { kind: "project"; key: string }
  | { kind: "session"; key: string; projectKey?: string | null };
export type ArchiveRow = Omit<LocalRow, "id" | "projectKey" | "projectPath"> & {
  projectRef: string | null;
  projectLabel: string | null;
  projectPath?: string;
};
export type ArchiveSummary = {
  sourceLabel?: string | null;
  sourceId?: string | null;
  clientId?: string | null;
  identityStatus?: ClientIdentityStatus;
  sessionId?: string | null;
  tool?: string | null;
  projectLabel?: string | null;
  id: string;
  savedAt: number;
  collectedAt: number;
  periodKey: string;
  /** 采集时的本地 UTC 偏移（秒）；旧归档为 null（未知，导出时不补写）。 */
  accountingUtcOffsetSeconds?: number | null;
  scope: string;
  includesPaths: boolean;
  complete: boolean;
  stale: boolean;
  /** Missing/old empty evidence remains unknown. */
  qualityEvidenceRecorded?: boolean;
  qualityWarnings?: string[];
  rowCount: number;
};
export type ArchiveEntry = Omit<ArchiveSummary, "rowCount"> & {
  engineVersion: string;
  rows: ArchiveRow[];
};
export function archiveIdentityLabel(
  entry: ArchiveSummary | ArchiveEntry,
): string {
  const identity = "rows" in entry ? localIdentity(entry.rows) : entry;
  return identity.identityStatus === "mixed"
    ? "多个客户端（混合身份）"
    : localClientLabel(identity.clientId);
}
export function archiveSelectionLabel(
  entry: ArchiveSummary | ArchiveEntry,
): string {
  if ("rows" in entry) {
    const labels = [
      ...new Set(
        entry.rows.map(
          (row) =>
            `${row.sourceLabel || row.sourceId || "来源未知"} · ${localClientLabel(row.clientId)} · ${row.sessionId}`,
        ),
      ),
    ];
    return (
      labels.slice(0, 5).join("；") +
      (labels.length > 5
        ? `；另 ${labels.length - 5} 个会话身份（共 ${labels.length} 个）`
        : "")
    );
  }
  return `${entry.sourceLabel || entry.sourceId || "多个来源"} · ${archiveIdentityLabel(entry)} · ${entry.sessionId || "多个会话"}`;
}
export const archiveScopeLabel = (scope: string) =>
  scope === "session" ? "会话" : scope === "project" ? "项目" : "全部记录";
export function archiveLocalRows(entry: ArchiveEntry): LocalRow[] {
  return entry.rows.map((row, index) => ({
    ...row,
    id: `archive-${index}`,
    projectKey: row.projectRef,
    projectPath: row.projectPath || null,
  }));
}
export function archiveExport(entry: ArchiveEntry, retained = false) {
  const captureKind = retained
    ? "automatic-session-checkpoint"
    : "manual-snapshot";
  const fields = [
    "sourceId",
    "sourceLabel",
    "tool",
    // 复评 T03：归档/留存导出必须保留 client 身份（实时导出已补，这里同步）。
    // 旧档没有该字段时输出 `"legacy-unknown"`，不伪造原生身份。
    "clientId",
    "sessionId",
    "model",
    "projectRef",
    "projectLabel",
    ...(entry.includesPaths ? ["projectPath"] : []),
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "totalTokens",
    "messageCount",
    "timedOutputTokens",
    "timedDurationMs",
    "tokenAccuracy",
    "timingCoverage",
  ];
  const metadata = [
    "periodKey",
    "collectedAt",
    "savedAt",
    "scope",
    "complete",
    "stale",
    "includesPaths",
    // 复评 T05：质量证据随归档导出，下游才能区分「读取完整」与「去重可信」。
    "qualityEvidenceRecorded",
    "qualityWarnings",
  ] as const;
  // 旧归档没有偏移字段：保持 null，不用导出时的电脑时区补写。
  const offset =
    typeof entry.accountingUtcOffsetSeconds === "number" &&
    Number.isInteger(entry.accountingUtcOffsetSeconds) &&
    Math.abs(entry.accountingUtcOffsetSeconds) < 86400
      ? entry.accountingUtcOffsetSeconds
      : null;
  const quality = snapshotQuality(entry);
  // Entry data came from the backend archive whitelist. CSV selects fields again.
  return {
    json: JSON.stringify(
      {
        schemaVersion: 2,
        kind: "saved-local-usage-snapshot",
        captureKind,
        id: entry.id,
        engineVersion: entry.engineVersion,
        accountingUtcOffsetSeconds: offset,
        ...Object.fromEntries(metadata.map((field) => [field, entry[field]])),
        ...quality,
        rows: entry.rows.map((row) =>
          Object.fromEntries(
            [...fields, "firstActiveMs", "lastActiveMs"].map((field) => [
              field,
              field === "tokenAccuracy"
                ? "unclassified"
                : field === "clientId"
                  ? (row as Record<string, unknown>)[field] || "legacy-unknown"
                  : (row as Record<string, unknown>)[field],
            ]),
          ),
        ),
      },
      null,
      2,
    ),
    csv:
      "\uFEFF" +
      [
        [...fields, ...metadata, "accountingUtcOffsetSeconds", "captureKind"],
        ...entry.rows.map((row) => [
          ...fields.map((field) =>
            field === "tokenAccuracy"
              ? "unclassified"
              : field === "clientId"
                ? (row as Record<string, unknown>)[field] || "legacy-unknown"
                : (row as Record<string, unknown>)[field],
          ),
          ...metadata.map((field) =>
            field === "qualityWarnings"
              ? quality.qualityWarnings.join(";")
              : field === "qualityEvidenceRecorded"
                ? quality.qualityEvidenceRecorded
                : entry[field],
          ),
          offset,
          captureKind,
        ]),
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n") +
      "\r\n",
  };
}
export function localPeriodKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
