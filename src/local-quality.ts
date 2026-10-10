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
