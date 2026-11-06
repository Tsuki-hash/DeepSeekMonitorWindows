// 全局离开拦截（草稿保护）。
//
// 复评 F09：采集目录的草稿保护原先只在 LocalUsagePanel 内部生效，
// 底部主导航直接 `setView` 会绕过它；而「保存并离开」按钮只切回设置页，
// 既没保存也没执行原本的离开动作。
//
// 这里把「有没有未保存草稿」「离开前要做什么」提升为 App 级契约：
// 任何导航出口（主导航、面板返回、归档入口）都先问 blocker。

import React from "react";

export type LeaveBlocker = {
  /** 是否有未保存的修改。 */
  dirty: boolean;
  /** 人类可读的主体名，用于提示文案。 */
  subject: string;
  /** 用户选择「保存并离开」时调用；成功返回 true。 */
  save: () => Promise<boolean>;
  /** 放弃修改：清理本地草稿状态。 */
  discard: () => void;
};

/**
 * 注册离开拦截器。返回注册函数与注销函数。
 *
 * 用 ref 而非 state 保存：导航出口需要同步读取当前值，不能等下一次渲染。
 */
export function useLeaveGuard() {
  const blocker = React.useRef<LeaveBlocker | null>(null);
  const register = React.useCallback((next: LeaveBlocker | null) => {
    blocker.current = next;
  }, []);
  return { blocker, register };
}

export type LeaveDecision = "save" | "discard" | "cancel";

/**
 * 执行一次「带拦截的离开」。
 *
 * - 无草稿：直接执行。
 * - 有草稿：返回 `"blocked"`，由调用方渲染三选一提示；
 *   用户选择后再调用 `resolveLeave`。
 */
export function attemptLeave(
  blocker: LeaveBlocker | null,
  action: () => void,
): "done" | "blocked" {
  if (!blocker?.dirty) {
    action();
    return "done";
  }
  return "blocked";
}

/**
 * 用户在三选一中做出决定。
 *
 * 保存失败时**不离开**：返回 false，调用方保留当前页与草稿。
 */
export async function resolveLeave(
  blocker: LeaveBlocker | null,
  decision: LeaveDecision,
  action: () => void,
): Promise<boolean> {
  if (!blocker) {
    if (decision === "cancel") return false;
    action();
    return true;
  }
  if (decision === "cancel") return false;
  if (decision === "discard") {
    blocker.discard();
    action();
    return true;
  }
  const saved = await blocker.save();
  if (!saved) return false;
  action();
  return true;
}
