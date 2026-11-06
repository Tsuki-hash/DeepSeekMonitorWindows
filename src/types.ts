import type { UsageDay } from "./format";

export type ViewName = "dashboard" | "settings" | "detail" | "history";
export type ModelName = "flash" | "pro" | "other";
export type AppConfig = {
  /** Non-secret process-local backend commit versions, captured with this snapshot. */
  configRevision: number;
  apiKeyRevision: number;
  usageTokenRevision: number;
  configWarnings?: string[];
  /** Untrusted disk state: account data is revoked and preference writes are disabled. */
  configReadError?: string | null;
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  usageTokenConfigured: boolean;
  /** Durable non-secret cleanup ID; its presence means browser deletion is unconfirmed. */
  usageCleanupUnconfirmed?: string | null;
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  configPath: string;
};
export type BalanceData = {
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
};
export type SavedApiKey = { config: AppConfig; balance: BalanceData };
// 通用的异步加载状态，余额与用量共用。
export type LoadState = "loading" | "ok" | "error" | "nokey";
// 计数为 null 表示平台没给或无法解析，**不等于零**；金额为 null 同理。
export type UsageModel = {
  key: string;
  name: string;
  totalTokens: number | null;
  requestCount: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  responseTokens: number | null;
  otherTokens: number | null;
  cost: number | null;
};
export type UsageResult = {
  schemaVersion?: number;
  modelMappingVersion?: string;
  rawModels?: RawModelUsage[];
  accountingDate?: string;
  warnings?: string[];
  unavailableDates?: string[];
  models: UsageModel[];
  days: UsageDay[];
  monthCost: number | null;
};

export type RawModelUsage = {
  dataWarning?: string | null;
  model: string;
  groupKey: string | null;
  totalTokens: number | null;
  requestCount: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  responseTokens: number | null;
  otherTokens: number | null;
  cost: number | null;
};

/** Independent login lifecycle identity; never inferred from credential versions. */
export type UsageSyncStatus = {
  generation: number;
  requestId: string | null;
  active: boolean;
  kind: "web" | "manual";
};
export type UsageSyncStarted = UsageSyncStatus & { synced: boolean };
export type UsageTokenCaptured = UsageSyncStatus & { config: AppConfig };
