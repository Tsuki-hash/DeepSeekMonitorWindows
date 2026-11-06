// Pure count arithmetic shared by chart and trust calculations. Keep this module
// independent of history/format so consumers cannot introduce an import cycle.
export type UsageCountSum = {
  total: number | null;
  issue: "unknown" | "unsafe" | null;
};

/** Unknown is not zero. Every operand and every partial sum must remain safe. */
export function sumUsageCounts(
  values: readonly (number | null | undefined)[],
): UsageCountSum {
  let total = 0;
  let unknown = false;
  for (const value of values) {
    if (value == null) {
      unknown = true;
      continue;
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - total
    ) {
      return { total: null, issue: "unsafe" };
    }
    total += value;
  }
  return unknown ? { total: null, issue: "unknown" } : { total, issue: null };
}
