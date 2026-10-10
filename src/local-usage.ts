export const localTools: Record<string, string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  zcode: "ZCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  dsh: "DeepSeek Harness",
};
export type LocalRow = {
  tokenAccuracy?: "unclassified";
  timingCoverage?: "matched" | "partial" | "unavailable" | "unverified";
  sourceId?: string;
  sourceLabel?: string;
  id: string;
  tool: string;
  sessionId: string;
  projectKey: string | null;
  projectPath: string | null;
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  totalTokens: number | null;
  messageCount: number | null;
  timedOutputTokens: number | null;
  timedDurationMs: number | null;
  firstActiveMs: number | null;
  lastActiveMs: number | null;
};
export type LocalSnapshot = {
  retentionWarning?: string | null;
  collectedAt: number;
  engineVersion: string;
  period: "month";
  periodKey?: string;
  accountingUtcOffsetSeconds?: number | null;
  rows: LocalRow[];
  complete?: boolean;
  sources?: {
    id: string;
    label: string;
    state: string;
    message: string | null;
  }[];
};
export type LocalUsageStatus = {
  enabled: boolean;
  snapshot: LocalSnapshot | null;
  busy?: boolean;
  lastError?: string | null;
};
export type LocalGroup = {
  key: string;
  label: string;
  path: string | null;
  rows: LocalRow[];
};
export function localSum(
  rows: LocalRow[],
  field: keyof LocalRow,
): number | null {
  const values = rows.map((row) => row[field]);
  if (
    !values.length ||
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    )
  )
    return null;
  const sum = values.reduce<number>(
    (total, value) => total + (value as number),
    0,
  );
  return Number.isSafeInteger(sum) ? sum : null;
}
export function localProjects(rows: LocalRow[]): LocalGroup[] {
  const groups = new Map<string, LocalGroup>();
  for (const row of rows) {
    const key = row.projectKey || `${row.sourceId || "native"}\0unassigned`;
    if (!groups.has(key)) {
      const path = row.projectPath;
      groups.set(key, {
        key,
        path,
        label: path
          ? path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || path
          : "未归属项目",
        rows: [],
      });
    }
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) =>
      (localSum(b.rows, "totalTokens") || 0) -
        (localSum(a.rows, "totalTokens") || 0) || a.key.localeCompare(b.key),
  );
}
export function localSessions(rows: LocalRow[]): LocalGroup[] {
  const groups = new Map<string, LocalGroup>();
  for (const row of rows) {
    const key = `${row.sourceId || "native"}\0${row.tool}\0${row.sessionId}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        label: row.sessionId,
        path: row.projectPath,
        rows: [],
      });
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Math.max(...b.rows.map((r) => r.lastActiveMs || 0)) -
        Math.max(...a.rows.map((r) => r.lastActiveMs || 0)) ||
      a.key.localeCompare(b.key),
  );
}
export function localAverageRate(rows: LocalRow[]): number | null {
  const timed = rows.filter(
    (row) =>
      row.timedDurationMs != null &&
      row.timedOutputTokens != null &&
      row.timedDurationMs > 0,
  );
  if (!timed.length) return null;
  const output = localSum(timed, "timedOutputTokens");
  const duration = localSum(timed, "timedDurationMs");
  return output != null && duration != null && duration > 0
    ? (output * 1000) / duration
    : null;
}
type Counters = { output: number; duration: number };
// Matched performance counters, as in Token Monitor. Never divide by poll/watcher time.
export class LocalRateTracker {
  private baseline = new Map<string, Counters>();
  private sample: { rate: number; at: number } | null = null;
  reset() {
    this.baseline.clear();
    this.sample = null;
  }
  observe(rows: LocalRow[], now = Date.now()) {
    const next = new Map<string, Counters>();
    let output = 0;
    let duration = 0;
    let regressed = false;
    for (const row of rows) {
      if (row.timedOutputTokens == null || row.timedDurationMs == null)
        continue;
      const current = {
        output: row.timedOutputTokens,
        duration: row.timedDurationMs,
      };
      next.set(row.id, current);
      const previous = this.baseline.get(row.id);
      if (!previous) continue; // A newly discovered history row is a baseline, not a live sample.
      const changeOutput = current.output - previous.output;
      const changeDuration = current.duration - previous.duration;
      if (changeOutput < 0 || changeDuration < 0) {
        regressed = true;
        continue;
      }
      if (changeDuration > 0) {
        output += changeOutput;
        duration += changeDuration;
      }
    }
    for (const key of this.baseline.keys())
      if (!next.has(key)) regressed = true;
    this.baseline = next;
    if (
      regressed ||
      !Number.isSafeInteger(output) ||
      !Number.isSafeInteger(duration)
    )
      this.sample = null;
    else if (duration > 0)
      this.sample = { rate: (output * 1000) / duration, at: now };
  }
  reading(now = Date.now()) {
    if (!this.sample || now < this.sample.at || now - this.sample.at >= 180000)
      return null;
    return { ...this.sample, fresh: now - this.sample.at < 8000 };
  }
}
