import {
  localClientLabel,
  localIdentity,
  localSessionLabel,
  localSessionIdentityKey,
  localSourceLabel,
  localSourceCatalog,
  localSourceExportIdentity,
  localSourcesLabel,
  localTools,
} from "./local-usage.ts";
import type {
  ClientIdentityStatus,
  SourceIdentity,
  SourceIdentityStatus,
} from "./local-usage";
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
  /** Derived from rows on read, never persisted or backfilled into old archives. */
  sourceCount?: number;
  sourceHasUnknown?: boolean;
  sourceIdentityStatus?: SourceIdentityStatus;
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
export function archiveSourceLabel(
  entry: ArchiveSummary | ArchiveEntry,
  sources: readonly SourceIdentity[] = [],
  fullId = false,
): string {
  if ("rows" in entry)
    return localSourcesLabel(entry.rows, [...sources, ...entry.rows], fullId);
  if (entry.sourceIdentityStatus === "mixed" || (entry.sourceCount ?? 0) > 1) {
    return `多个来源${entry.sourceCount ? `（${entry.sourceCount} 个已知${entry.sourceHasUnknown ? "，含未知身份" : ""}）` : "（含未知身份）"}`;
  }
  if (entry.sourceId && entry.sourceId !== "legacy-unknown")
    return localSourceLabel(
      { sourceId: entry.sourceId, sourceLabel: entry.sourceLabel || undefined },
      sources,
      fullId,
    );
  // Older summaries with no unique ID cannot establish one source from a label.
  return entry.sourceIdentityStatus === "unknown"
    ? "来源身份未知"
    : "多个来源或身份未知";
}
export function archiveSelectionLabel(
  entry: ArchiveSummary | ArchiveEntry,
  sources: readonly SourceIdentity[] = [],
  fullId = false,
): string {
  if ("rows" in entry) {
    const identities = new Map<string, ArchiveRow>();
    for (const row of entry.rows) {
      const key = localSessionIdentityKey(row);
      const previous = identities.get(key);
      if (
        !previous ||
        (row.sourceLabel || "").localeCompare(previous.sourceLabel || "") < 0
      )
        identities.set(key, row);
    }
    const context = localSourceCatalog([...sources, ...entry.rows]);
    const labels = [...identities]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => localSessionLabel(row, context, fullId));
    return (
      (fullId ? labels : labels.slice(0, 5)).join("；") +
        (!fullId && labels.length > 5
          ? `；另 ${labels.length - 5} 个会话身份（共 ${labels.length} 个）`
          : "") || "会话身份未知"
    );
  }
  return `${archiveSourceLabel(entry, sources, fullId)} · ${entry.tool ? localTools[entry.tool] || entry.tool : "多个工具"} · ${archiveIdentityLabel(entry)} · ${entry.sessionId || "多个会话"}`;
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
  // Legacy stores may predate opaque source IDs. Redact only the export projection;
  // enabling project paths never authorizes arbitrary source IDs as secret text.
  const exportRows = entry.rows.map((row) => ({
    ...row,
    ...localSourceExportIdentity(row),
  }));
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
        rows: exportRows.map((row) =>
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
        ...exportRows.map((row) => [
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
