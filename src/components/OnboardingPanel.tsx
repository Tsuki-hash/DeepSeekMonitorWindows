import React from "react";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Folder,
  LineChart,
} from "lucide-react";
import type { OnboardingTask, OnboardingTaskInfo } from "../onboarding";

const icons = {
  balance: CreditCard,
  platform: LineChart,
  local: Folder,
} as const;

/**
 * 首次使用的三张入口卡。
 *
 * 评审 P2：不是强制向导，而是「选一个目标开始」。每张卡只说明该任务的最小条件，
 * 已完成的任务标勾，敏感会话（平台用量）在进入前先说明会过期。
 */
export function OnboardingPanel({
  tasks,
  onChoose,
  onDismiss,
}: {
  tasks: OnboardingTaskInfo[];
  onChoose: (task: OnboardingTask) => void;
  onDismiss: () => void;
}) {
  return (
    <article className="card onboarding-panel" data-testid="onboarding-panel">
      <h2>先选一个目标</h2>
      <p className="muted">
        三种数据来源彼此独立，可以只用其中一种。不需要全部配置完才能开始。
      </p>
      <div className="onboarding-tasks">
        {tasks.map((task) => {
          const Icon = icons[task.task];
          return (
            <button
              key={task.task}
              className="onboarding-task"
              onClick={() => onChoose(task.task)}
            >
              <span className="onboarding-icon">
                {task.done ? (
                  <CheckCircle2 size={20} aria-hidden="true" />
                ) : (
                  <Icon size={20} aria-hidden="true" />
                )}
              </span>
              <span className="onboarding-copy">
                <strong>{task.title}</strong>
                <small>{task.summary}</small>
                <small className="onboarding-requirement">
                  {task.done ? "已完成" : `需要：${task.requirement}`}
                </small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <button className="link-button" onClick={onDismiss}>
        我已了解，先不配置
      </button>
    </article>
  );
}
