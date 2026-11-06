import React from "react";
import { draftGuardActions, draftGuardText } from "../draft-guard";
import type { LeaveDecision } from "../leave-guard";
import type { WindowVisibilityGate } from "../window-visibility-gate";

/**
 * 「有未保存修改」三选一提示。
 *
 * 凭据与提醒设置共用一个提示，保持对话框命名、焦点归还与提交中保护一致。
 *
 * 焦点策略：出现时聚焦首个可用按钮；仅“留在此页”且仍拥有焦点时归还。
 * 成功离开或被其它导航替代时，由 App 的新导航负责焦点，卸载不另行抢回。
 * 非模态提示不加焦点陷阱 —— 与「用户仍可看到页面」的交互一致。
 */
export function LeavePromptDialog({
  subject,
  submitting,
  onDecide,
  windowVisibilityGate,
}: {
  /** 未保存内容的主体名，例如「提醒设置」。 */
  subject: string;
  /** 保存进行中：保存与放弃禁用，避免重复提交（复评 T05）。 */
  submitting: boolean;
  onDecide: (decision: LeaveDecision) => void;
  /** 与 App 共用同步原生可见性，不等待 hidden 的 React 提交。 */
  windowVisibilityGate: WindowVisibilityGate;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);
  const cancelFirstFocus = React.useRef<() => void>(() => {});
  const returnFocus = React.useRef<() => void>(() => {});
  const focusDuringSave = React.useRef<() => void>(() => {});
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const origin = document.activeElement;
    const epoch = windowVisibilityGate.epoch();
    let live = true;
    let owned =
      windowVisibilityGate.isVisible() &&
      document.visibilityState === "visible" &&
      document.hasFocus?.() !== false;
    let frame: number | null = null;
    const cancelFirst = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const revoke = () => {
      owned = false;
      cancelFirst();
    };
    const available = () =>
      live &&
      owned &&
      windowVisibilityGate.epoch() === epoch &&
      windowVisibilityGate.isVisible() &&
      document.visibilityState === "visible" &&
      document.hasFocus?.() !== false;
    const inside = (target: EventTarget | null) =>
      target instanceof HTMLElement && container?.contains(target) === true;
    const usable = (node: HTMLElement | null): node is HTMLElement =>
      !!node?.isConnected &&
      !node.closest("[inert], [hidden], :disabled") &&
      node.getClientRects().length > 0;
    const onInteraction = (event: Event) => {
      // 对话框内的 Tab/点击也撤销尚未执行的首焦点；内部操作仍可正常取消。
      cancelFirst();
      if (!inside(event.target)) revoke();
    };
    const onFocus = (event: FocusEvent) => {
      if (
        event.target === document.body ||
        event.target === document.documentElement
      ) {
        return;
      }
      onInteraction(event);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") revoke();
    };
    const unsubscribe = windowVisibilityGate.subscribeInvalidation(revoke);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onInteraction, true);
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", revoke);
    cancelFirstFocus.current = cancelFirst;
    returnFocus.current = () => {
      // 在卸载前核对真实 activeElement。后台、外部新焦点、失效触发器均不归还。
      if (
        available() &&
        inside(document.activeElement) &&
        origin instanceof HTMLElement &&
        usable(origin)
      ) {
        revoke();
        origin.focus({ preventScroll: true });
      }
    };
    focusDuringSave.current = () => {
      // Chromium 会在当前按钮变为 disabled 时失焦。先把仍属于提示的
      // 焦点交给始终可用的取消按钮，不等提交后再从 body 猜测恢复目标。
      // 这是本次明确保存操作的同步交接：用户曾离开再回来也应安全。
      // 不恢复 owned/旧 epoch，因此首焦点和旧触发器归还仍保持失效。
      const cancel = cancelButtonRef.current;
      if (
        live &&
        windowVisibilityGate.isVisible() &&
        document.visibilityState === "visible" &&
        document.hasFocus?.() !== false &&
        inside(document.activeElement) &&
        usable(cancel)
      ) {
        cancel.focus({ preventScroll: true });
      }
    };
    if (owned) {
      const scheduled = window.requestAnimationFrame(() => {
        // 宿主即使交付已取消的 RAF，也不能恢复其所有权。
        if (frame !== scheduled) return;
        frame = null;
        const active = document.activeElement;
        if (
          !available() ||
          (active !== origin &&
            active !== document.body &&
            active !== document.documentElement)
        ) {
          revoke();
          return;
        }
        const button =
          container?.querySelector<HTMLElement>("button:not(:disabled)") ??
          null;
        if (usable(button)) button.focus({ preventScroll: true });
      });
      frame = scheduled;
    }
    return () => {
      live = false;
      revoke();
      unsubscribe();
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onInteraction, true);
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", revoke);
      cancelFirstFocus.current = () => {};
      returnFocus.current = () => {};
      focusDuringSave.current = () => {};
    };
  }, [windowVisibilityGate]);
  const decide = (decision: LeaveDecision) => {
    if (submitting && decision !== "cancel") return;
    cancelFirstFocus.current();
    if (decision === "save") focusDuringSave.current();
    if (decision === "cancel") returnFocus.current();
    onDecide(decision);
  };
  return (
    <div
      ref={containerRef}
      className="leave-guard"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="leave-guard-title"
      aria-describedby="leave-guard-desc"
    >
      <p id="leave-guard-title" className="leave-guard-title">
        {draftGuardText(subject)}
      </p>
      <p id="leave-guard-desc" className="muted">
        选择后才会离开；保存失败会留在当前页。
      </p>
      <div className="disclosure-actions">
        <button
          className="primary"
          disabled={submitting}
          onClick={() => decide("save")}
        >
          {submitting ? "保存中…" : draftGuardActions.save}
        </button>
        <button
          className="secondary"
          disabled={submitting}
          onClick={() => decide("discard")}
        >
          {draftGuardActions.discard}
        </button>
        {/* 取消始终可用：它是用户收回导航请求的唯一出口（复评 T05）。 */}
        <button
          ref={cancelButtonRef}
          className="secondary"
          onClick={() => decide("cancel")}
        >
          {draftGuardActions.cancel}
        </button>
      </div>
    </div>
  );
}
