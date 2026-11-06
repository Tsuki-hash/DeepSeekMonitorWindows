import type { AppConfig, BalanceData } from "./types";

// 复评 F08：已提交配置需要一个**单调提交代际**。
//
// 旧实现里任何一次 `get_app_config` 返回都会无条件覆盖 store：如果旧读取
// 在用户保存凭据之后才到达，已保存的「已配置」会被回滚成「未配置」，
// 清除按钮等能力跟着错误状态变化（磁盘上的凭据并没有丢）。
//
// 现在每次**写入类**提交（保存/清除/偏好保存/事件）递增 `commitRevision`；
// 读取发起时捕获当时的 revision，返回时若已有更新的提交则丢弃该读取结果。
// 这样无论多少个组件、多少个读取/写入交错，旧读取都不能回滚新提交。
let current: AppConfig | null = null;
let commitRevision = 0;
let validatedBalance: { revision: number; balance: BalanceData } | null = null;
export const getValidatedBalance = () => validatedBalance;
// A verification receipt predates the command event. Once a newer fetch has
// settled for that Key, its outcome owns the account state (including 401).
let observedBalanceRevision: number | null = null;
export const markBalanceObserved = (revision: number | undefined) => {
  if (revision === undefined || current?.apiKeyRevision !== revision) return;
  observedBalanceRevision = revision;
  validatedBalance = null;
};
const listeners = new Set<() => void>();

export const getCommittedConfig = () => current;

/** 当前提交代际：读取方在发起请求时捕获，返回时据此判断是否过期。 */
export const getCommitRevision = () => commitRevision;

export const subscribeCommittedConfig = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Accept only a newer whole backend snapshot. Equal events/responses are idempotent. */
export const setCommittedConfig = (
  config: AppConfig | null,
  balance?: BalanceData,
): boolean => {
  const newer =
    !config || !current || config.configRevision > current.configRevision;
  // A later preference/Token commit may have arrived first. Its whole snapshot
  // wins, but a validated balance is still useful if its Key version is current.
  const acceptBalance = Boolean(
    config &&
    balance &&
    config.apiKeyConfigured &&
    config.apiKeyRevision !== observedBalanceRevision &&
    (newer || current?.apiKeyRevision === config.apiKeyRevision),
  );
  if (!newer && !acceptBalance) return false;
  if (newer) {
    current = config;
    if (!config) observedBalanceRevision = null;
    commitRevision += 1;
    if (!config || validatedBalance?.revision !== config.apiKeyRevision)
      validatedBalance = null;
  }
  if (acceptBalance && config && balance)
    validatedBalance = { revision: config.apiKeyRevision, balance };
  for (const listener of listeners) listener();
  return true;
};

/** Reads cannot roll back a newer backend commit or a write accepted since start. */
export const applyReadConfig = (
  config: AppConfig | null,
  startedAt: number,
): boolean => {
  if (startedAt !== commitRevision) return false;
  if (config && current && config.configRevision < current.configRevision)
    return false;
  if (config && current && config.configRevision === current.configRevision)
    return true;
  current = config;
  if (!config || validatedBalance?.revision !== config.apiKeyRevision)
    validatedBalance = null;
  for (const listener of listeners) listener();
  return true;
};

/** A result may be older overall but still belong to the current credential. */
export const isCurrentCredential = (
  config: AppConfig,
  credential: "apiKey" | "usageToken",
): boolean => {
  if (!current) return false;
  return credential === "apiKey"
    ? current.apiKeyRevision === config.apiKeyRevision
    : current.usageTokenRevision === config.usageTokenRevision;
};
