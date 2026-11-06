import type { LocalRow } from "./local-usage";
export type FieldCoverage = "complete" | "partial" | "missing" | "unverified";
export type TimingCoverage =
  "matched" | "partial" | "unavailable" | "unverified";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function localEvidence(row: LocalRow) {
  const values = [
    row.input,
    row.output,
    row.cacheRead,
    row.cacheWrite,
    row.totalTokens,
  ];
  const known = values.filter(count).length;
  let fields: FieldCoverage =
    known === 0 ? "missing" : known < values.length ? "partial" : "complete";
  if (fields === "complete") {
    const sum = values
      .slice(0, 4)
      .reduce<number>((total, value) => total + (value ?? 0), 0);
    if (!count(sum) || sum !== row.totalTokens) fields = "unverified";
  }
  const usable =
    count(row.timedOutputTokens) &&
    count(row.timedDurationMs) &&
    row.timedDurationMs > 0 &&
    row.timedOutputTokens === row.output;
  const declared = row.timingCoverage;
  const timing: TimingCoverage =
    declared === "partial" ||
    declared === "unavailable" ||
    declared === "unverified"
      ? declared
      : declared === "matched"
        ? usable && fields === "complete"
          ? "matched"
          : "unverified"
        : usable && fields === "complete"
          ? "matched"
          : "unavailable";
  // No fixed-engine field establishes per-row measured/estimated provenance.
  return {
    tokenAccuracy: "unclassified" as const,
    tokenFields: fields,
    timingCoverage: timing,
  };
}
export function qualitySummary(rows: LocalRow[]) {
  const fields: Record<FieldCoverage, number> = {
    complete: 0,
    partial: 0,
    missing: 0,
    unverified: 0,
  };
  const timing: Record<TimingCoverage, number> = {
    matched: 0,
    partial: 0,
    unavailable: 0,
    unverified: 0,
  };
  for (const row of rows) {
    const evidence = localEvidence(row);
    fields[evidence.tokenFields]++;
    timing[evidence.timingCoverage]++;
  }
  return { rows: rows.length, fields, timing };
}

/** Snapshot-level evidence is independent of read completeness and row coverage.
 * Missing/old empty evidence stays unknown; old nonempty codes remain useful.
 * Never copy diagnostic messages or paths into this public projection.
 */
export type QualityEvidence = {
  qualityEvidenceRecorded?: boolean;
  qualityWarnings?: string[];
};
export function snapshotQuality(evidence: QualityEvidence) {
  const warnings = evidence.qualityWarnings || [];
  return {
    qualityEvidenceRecorded:
      evidence.qualityEvidenceRecorded === true || warnings.length > 0,
    qualityWarnings: [
      ...new Set(
        warnings.map((code) =>
          /^[a-z][a-z0-9_-]{0,63}$/.test(code)
            ? code
            : "quality_warning_redacted",
        ),
      ),
    ].sort(),
  };
}
export function snapshotQualityLabel(evidence: QualityEvidence): string {
  const quality = snapshotQuality(evidence);
  if (!quality.qualityEvidenceRecorded) return "质量证据未记录，去重可信度未知";
  if (!quality.qualityWarnings.length)
    return "质量检查已记录，未报告风险（不代表已证明无重叠）";
  const explanation = quality.qualityWarnings.includes("overlap_partial")
    ? "部分来源范围重叠，合计可能重复计入"
    : "存在数据质量风险，合计需谨慎使用";
  return `${explanation} · ${quality.qualityWarnings.join("、")}`;
}
