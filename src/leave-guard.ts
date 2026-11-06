// 全局离开拦截（草稿保护）。
//
// 复评 F09：采集目录的草稿保护原先只在 LocalUsagePanel 内部生效，
// 底部主导航直接 `setView` 会绕过它；而「保存并离开」按钮只切回设置页，
// 既没保存也没执行原本的离开动作。
//
// 这里把「有没有未保存草稿」「离开前要做什么」提升为 App 级契约：
// 任何导航出口（主导航、面板返回、归档入口）都先问 blocker。
//
// 复评 R08：保存是异步的。用户在保存途中点「取消」后，迟到的保存成功
// 仍会执行导航，让取消失效；连点也会重复提交。因此每次决策带一个代际，
// 只有最新代际的完成才允许执行导航。

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

/** 一次离开决策的令牌：代际 + 是否已结束。 */
export type LeaveTicket = {
  generation: number;
  cancelled: boolean;
};

/**
 * 创建决策令牌。每次点击三选一都递增代际；旧令牌自动失效。
 *
 * 调用方持有最新令牌，异步保存返回时用 `isCurrent` 判断是否仍然有效。
 */
export class LeaveDecisions {
  private generation = 0;
  /** 当前最新令牌；null 表示没有待决的离开。 */
  private current: LeaveTicket | null = null;

  /** 开始一次新的决策，使之前的令牌全部失效。 */
  begin(): LeaveTicket {
    this.generation += 1;
    const ticket = { generation: this.generation, cancelled: false };
    this.current = ticket;
    return ticket;
  }

  /** 用户取消：使当前令牌失效。 */
  cancel(ticket: LeaveTicket) {
    ticket.cancelled = true;
    if (this.current === ticket) this.current = null;
    this.generation += 1;
  }

  /** 该令牌是否仍可执行导航（未被取消且仍是最新）。 */
  isCurrent(ticket: LeaveTicket): boolean {
    return (
      !ticket.cancelled &&
      ticket.generation === this.generation &&
      this.current === ticket
    );
  }

  /** 决策完成（已导航或已放弃）。 */
  finish(ticket: LeaveTicket) {
    if (this.current === ticket) this.current = null;
  }
}

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
 *
 * `isStillCurrent` 在 await 之后被再次检查：用户在保存途中取消，
 * 即使保存成功也不得导航（复评 R08）。
 */
export async function resolveLeave(
  blocker: LeaveBlocker | null,
  decision: LeaveDecision,
  action: () => void,
  isStillCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!blocker) {
    if (decision === "cancel") return false;
    action();
    return true;
  }
  if (decision === "cancel") return false;
  if (decision === "discard") {
    if (!isStillCurrent()) return false;
    blocker.discard();
    action();
    return true;
  }
  const saved = await blocker.save();
  if (!saved) return false;
  // 保存期间用户可能已取消：此时不得执行导航。
  if (!isStillCurrent()) return false;
  action();
  return true;
}
