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
  /** 复评 N01：稳定 client 身份；旧数据缺省时身份未知，不根据 tool 猜测。 */
  clientId?: string;
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
export type ClientIdentityStatus = "known" | "mixed" | "unknown";
export type SourceIdentity = Pick<LocalRow, "sourceId" | "sourceLabel">;
export type SourceIdentityStatus = "known" | "mixed" | "unknown";
/** Only generated opaque IDs may become visible text, titles or accessible names. */
export function isKnownSourceId(id?: string | null): id is string {
  return (
    id === "native" || Boolean(id && /^(home-|tool-)[a-f0-9]{64}$/.test(id))
  );
}
export function localSourceCatalog(
  sources: readonly SourceIdentity[],
): SourceIdentity[] {
  const unique = new Map<string, SourceIdentity>();
  // Label is metadata, not identity. Never collapse distinct IDs with equal labels.
  for (const source of sources) {
    const key = source.sourceId || "legacy-unknown";
    const previous = unique.get(key);
    if (
      !previous ||
      (source.sourceLabel || "").localeCompare(previous.sourceLabel || "") < 0
    )
      unique.set(key, source);
  }
  return [...unique]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, source]) => source);
}

/** Export projection only; stored IDs and backend selection keys are never rewritten.
 * Unknown IDs may be a path or a secret, so even enabling project paths does not
 * turn them into an authorized source-ID field.
 */
export function localSourceExportIdentity(source: SourceIdentity) {
  if (!isKnownSourceId(source.sourceId))
    return { sourceId: "legacy-unknown", sourceLabel: "旧版来源身份未知" };
  const sourceLabel =
    source.sourceLabel &&
    ![...source.sourceLabel].some(
      (character) =>
        character === "/" ||
        character === "\\" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
      ? source.sourceLabel
      : source.sourceId === "native"
        ? "本机"
        : "来源";
  return { sourceId: source.sourceId, sourceLabel };
}

/** Display only the backend's opaque source ID, never derive a label from a home path.
 * Expand colliding digest prefixes using the whole view, independent of row order.
 * The full ID remains available in titles, accessible names and source details.
 */
export function localSourceLabel(
  source: SourceIdentity,
  sources: readonly SourceIdentity[] = [],
  fullId = false,
): string {
  const id = source.sourceId;
  // Old or damaged IDs can contain a raw path or a secret: do not echo them,
  // even in full-ID details. Do not trust their accompanying label either.
  if (!isKnownSourceId(id)) return "来源〔旧版来源身份未知〕";
  const label = localSourceExportIdentity(source).sourceLabel;
  let tag = id;
  const digest = /^(home-|tool-)([a-f0-9]{64})$/.exec(tag);
  if (digest && !fullId) {
    let length = digest[1].length + 12;
    while (
      length < tag.length &&
      sources.some(
        (other) =>
          isKnownSourceId(other.sourceId) &&
          other.sourceId !== id &&
          other.sourceId.startsWith(tag.slice(0, length)),
      )
    )
      length++;
    tag = tag.slice(0, length);
  }
  return `${label}〔${tag}〕`;
}
export function localSourceIdentity(sources: readonly SourceIdentity[]) {
  const known = new Set(
    sources.flatMap((source) =>
      isKnownSourceId(source.sourceId) ? [source.sourceId] : [],
    ),
  );
  const sourceHasUnknown = sources.some(
    (source) => !isKnownSourceId(source.sourceId),
  );
  return {
    sourceCount: known.size,
    sourceHasUnknown,
    sourceIdentityStatus: (known.size > 1 ||
    (known.size > 0 && sourceHasUnknown)
      ? "mixed"
      : known.size === 1
        ? "known"
        : "unknown") as SourceIdentityStatus,
  };
}
export function localSourcesLabel(
  rows: readonly SourceIdentity[],
  sources: readonly SourceIdentity[] = rows,
  fullId = false,
): string {
  const identity = localSourceIdentity(rows);
  const context = localSourceCatalog(sources);
  const labels = localSourceCatalog(rows).map((source) =>
    localSourceLabel(source, context, fullId),
  );
  const prefix =
    identity.sourceIdentityStatus === "mixed"
      ? `多个来源（${identity.sourceCount} 个已知${identity.sourceHasUnknown ? "，含未知身份" : ""}）：`
      : "";
  return prefix + (labels.join("；") || "来源身份未知");
}
/** Structured identity for display deduplication; keep backend selection keys unchanged. */
export function localSessionIdentityKey(
  row: Pick<LocalRow, "sourceId" | "tool" | "clientId" | "sessionId">,
): string {
  return JSON.stringify([
    row.sourceId || "legacy-unknown",
    row.tool,
    row.clientId || "legacy-unknown",
    row.sessionId,
  ]);
}
export function localClientLabel(clientId?: string | null): string {
  if (!clientId || clientId === "legacy-unknown") return "旧版身份未知";
  if (clientId === "claude") return "原生 Claude · claude";
  if (clientId === "claude-mirror" || clientId.startsWith("cc-mirror:"))
    return `镜像 · ${clientId}`;
  return `客户端 · ${clientId}`;
}
export function localIdentity(rows: Pick<LocalRow, "clientId">[]) {
  const clients = new Set(rows.map((row) => row.clientId || "legacy-unknown"));
  const clientId = clients.size === 1 ? [...clients][0] : null;
  return {
    clientId: clientId === "legacy-unknown" ? null : clientId,
    identityStatus: (clients.size > 1
      ? "mixed"
      : !clientId || clientId === "legacy-unknown"
        ? "unknown"
        : "known") as ClientIdentityStatus,
  };
}
export function localSessionLabel(
  row: Pick<
    LocalRow,
    "sourceId" | "sourceLabel" | "tool" | "clientId" | "sessionId"
  >,
  sources: readonly SourceIdentity[] = [],
  fullId = false,
): string {
  return `${localSourceLabel(row, sources, fullId)} · ${localTools[row.tool] || row.tool} · ${localClientLabel(row.clientId)} · ${row.sessionId}`;
}
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
  /** 复评 N03：质量证据（脱敏 code），与 complete 分开。 */
  qualityWarnings?: string[];
  qualityEvidenceRecorded?: boolean;
};
export type LocalUsageStatus = {
  enabled: boolean;
  snapshot: LocalSnapshot | null;
  busy?: boolean;
  lastError?: string | null;
  generation?: number;
  settingsPending?: boolean;
  stopSavePending?: boolean;
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
    // 复评 N01：会话身份必须含 client —— 原生 Claude 与 mirror 可能有
    // 同名 sessionId，只按 tool 分组会把它们合并成一个会话。
    const client = row.clientId || "legacy-unknown";
    const key = `${row.sourceId || "native"}\0${row.tool}\0${client}\0${row.sessionId}`;
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
