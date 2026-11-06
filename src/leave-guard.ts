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

/**
 * 跨出口一致的离开决策运行器（第五轮复评 Q04）。
 *
 * 一次决策 = 代际令牌 + 导航意图 + 提交中状态，三者同属一次决策：
 *
 * - 新导航意图（`requestIntent`）**立即取得所有权**：作废仍在途的旧决策。
 *   旧保存的迟到完成只清理自身，不得导航、不得清除新意图、
 *   不得解除新决策的提交状态。
 * - 被取代的旧保存**成功**时，草稿已落定，最新意图的前提（有脏草稿）
 *   已消失 —— 由运行器直接执行最新导航意图，不再多问一次。
 *   保存失败则保留最新意图的提示，交回用户决定。
 * - `cancel` 作废一切在途决策；连点/并发只认第一次（`decide` 在提交中忽略）。
 *
 * App 级出口与 LocalUsagePanel 局部出口共用本运行器，避免两处规则漂移。
 * 构造不用参数属性（Node --experimental-strip-types 只支持可擦除语法）。
 */
export class LeaveDecisionRunner {
  private decisions = new LeaveDecisions();
  private active: { ticket: LeaveTicket; intent: () => void } | null = null;
  private pending: (() => void) | null = null;
  private readonly getBlocker: () => LeaveBlocker | null;
  private readonly onSubmitting: (value: boolean) => void;
  private readonly onIntentCleared: () => void;

  constructor(
    getBlocker: () => LeaveBlocker | null,
    onSubmitting: (value: boolean) => void,
    onIntentCleared: () => void,
  ) {
    this.getBlocker = getBlocker;
    this.onSubmitting = onSubmitting;
    this.onIntentCleared = onIntentCleared;
  }

  /** 新导航意图：作废在途旧决策并成为最新待决意图。 */
  requestIntent(action: () => void): void {
    this.supersede();
    this.pending = action;
  }

  /** 用户取消：作废一切在途决策并清空待决意图（幂等）。 */
  cancel(): void {
    const had = this.active != null || this.pending != null;
    this.supersede();
    this.pending = null;
    if (had) {
      this.onIntentCleared();
      this.onSubmitting(false);
    }
  }

  /** 保存并离开 / 放弃并离开。提交中或无待决意图时忽略。 */
  decide(decision: "save" | "discard"): void {
    if (this.active) return; // 连点/并发只认第一次
    const intent = this.pending;
    if (!intent) return;
    const blocker = this.getBlocker();
    // 捕获保存结果：被取代的决策完成时，外部 dirty 状态可能还没
    // 经 React effect 刷新，保存 Promise 的结果才是确定性依据。
    let saved: boolean | null = decision === "discard" ? true : null;
    const wrapped: LeaveBlocker | null = blocker
      ? {
          ...blocker,
          save: async () => {
            const ok = await blocker.save();
            saved = ok;
            return ok;
          },
        }
      : null;
    const ticket = this.decisions.begin();
    this.active = { ticket, intent };
    this.onSubmitting(true);
    void resolveLeave(wrapped, decision, intent, () =>
      this.decisions.isCurrent(ticket),
    ).then((left) => {
      if (!this.decisions.isCurrent(ticket)) {
        // 被取代/取消的旧决策：只清理自身。若已有更新决策在途，
        // 提交状态归它管，这里不得触碰。
        if (!this.active) {
          this.onSubmitting(false);
          // 旧保存成功且有待决意图：草稿前提已消失，直接执行最新意图。
          if (saved === true && this.pending) {
            const next = this.pending;
            this.pending = null;
            this.onIntentCleared();
            next();
          }
        }
        return;
      }
      this.decisions.finish(ticket);
      this.active = null;
      this.onSubmitting(false);
      if (left) {
        this.pending = null;
        this.onIntentCleared();
      }
    });
  }

  /** 作废当前在途决策（若有）。 */
  private supersede(): void {
    if (this.active) {
      this.decisions.cancel(this.active.ticket);
      this.active = null;
    }
  }
}
