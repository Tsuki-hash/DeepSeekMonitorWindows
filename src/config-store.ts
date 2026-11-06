import type { AppConfig } from "./types";

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

/** 提交新配置（写入类操作），递增提交代际并通知所有已挂载实例。 */
export const setCommittedConfig = (config: AppConfig | null) => {
  current = config;
  commitRevision += 1;
  for (const listener of listeners) listener();
};

/**
 * 用**读取**结果更新 store：仅当自 `startedAt` 以来没有新的提交时才接受。
 * 返回是否被接受 —— 调用方据此决定要不要回填自己的局部状态。
 */
export const applyReadConfig = (
  config: AppConfig | null,
  startedAt: number,
): boolean => {
  if (startedAt !== commitRevision) return false;
  current = config;
  for (const listener of listeners) listener();
  return true;
};
