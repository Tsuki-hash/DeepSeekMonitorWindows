import React from "react";
import { draftGuardActions, draftGuardText } from "../draft-guard";
import type { LeaveDecision } from "../leave-guard";

/**
 * 「有未保存修改」三选一提示。
 *
 * 复评 T05/T08：全局（App）与局部（LocalUsagePanel）原先各写一份 JSX，
 * 局部那份没有对话框命名、初始焦点与焦点归还，也绕过了提交中保护。
 * 这里抽成共享组件：两个出口的语义、可访问性与按钮行为保持一致。
 *
 * 焦点策略：出现时把焦点移到第一个按钮，卸载时归还给触发控件。
 * 非模态提示不加焦点陷阱 —— 与「用户仍可看到页面」的交互一致。
 */
export function LeavePromptDialog({
  subject,
  submitting,
  onDecide,
}: {
  /** 未保存内容的主体名，例如「采集目录」。 */
  subject: string;
  /** 保存进行中：保存与放弃禁用，避免重复提交（复评 T05）。 */
  submitting: boolean;
  onDecide: (decision: LeaveDecision) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    // 记录触发控件：关闭（卸载）后把焦点还回去。
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const node = returnFocus.current;
      if (node?.isConnected) node.focus();
    };
  }, []);
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
          onClick={() => onDecide("save")}
        >
          {submitting ? "保存中…" : draftGuardActions.save}
        </button>
        <button
          className="secondary"
          disabled={submitting}
          onClick={() => onDecide("discard")}
        >
          {draftGuardActions.discard}
        </button>
        {/* 取消始终可用：它是用户收回导航请求的唯一出口（复评 T05）。 */}
        <button className="secondary" onClick={() => onDecide("cancel")}>
          {draftGuardActions.cancel}
        </button>
      </div>
    </div>
  );
}
