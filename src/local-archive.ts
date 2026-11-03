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
  rowCount: number;
};
export type ArchiveEntry = Omit<ArchiveSummary, "rowCount"> & {
  engineVersion: string;
  rows: ArchiveRow[];
};
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
  ] as const;
  // 旧归档没有偏移字段：保持 null，不用导出时的电脑时区补写。
  const offset =
    typeof entry.accountingUtcOffsetSeconds === "number" &&
    Number.isInteger(entry.accountingUtcOffsetSeconds) &&
    Math.abs(entry.accountingUtcOffsetSeconds) < 86400
      ? entry.accountingUtcOffsetSeconds
      : null;
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
        rows: entry.rows.map((row) =>
          Object.fromEntries(
            [...fields, "firstActiveMs", "lastActiveMs"].map((field) => [
              field,
              field === "tokenAccuracy"
                ? "unclassified"
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
              : (row as Record<string, unknown>)[field],
          ),
          ...metadata.map((field) => entry[field]),
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
