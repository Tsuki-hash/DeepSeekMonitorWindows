// 单通道调度钩子。
//
// 复评 R01：余额与用量共用同一个 `scheduleRevision`，任一通道状态变化都会
// 递增它，父 effect 随即清掉**两路** timer 重新倒计时 —— 于是健康通道每次成功
// 都会把失败通道的退避截止时间往后推，失败通道可能永远等不到重试。
//
// 这里把调度拆成每通道一个 hook：每个实例只管理自己的 timer 与截止时间，
// 另一个通道的完成不会触碰它的 dueAt。

import React from "react";
import {
  emptySchedule,
  isDue,
  msUntilDue,
  reschedule,
} from "./refresh-schedule";
import type { ChannelSchedule } from "./refresh-schedule";

export type SchedulerInput = {
  /** 是否启用自动刷新。 */
  enabled: boolean;
  /** 面板是否可见：隐藏时不联网。 */
  visible: boolean;
  /** 该通道是否暂停（未配置/凭据失效）。 */
  paused: boolean;
  /** 该通道下一次应等待的秒数（来自状态机）。 */
  delaySeconds: number;
  /** 实际执行的刷新；返回 Promise 表示请求结束。 */
  run: () => Promise<unknown>;
  /** 通道状态版本：同一通道内状态变化时才重排，不影响其他通道。 */
  revision: number;
};

/**
 * 为单个通道维护 setTimeout 链。
 *
 * 关键不变量：**只有本通道自己的状态变化才会重排**；另一个通道的完成
 * 既不清理本通道的 timer，也不推迟它的 dueAt。
 */
export function useChannelScheduler(input: SchedulerInput) {
  const { enabled, visible, paused, delaySeconds, run, revision } = input;
  const schedule = React.useRef<ChannelSchedule>(emptySchedule());
  // run 用 ref 读取，避免父组件每次渲染都重建 timer。
  const runRef = React.useRef(run);
  runRef.current = run;

  React.useEffect(() => {
    if (!enabled || !visible) {
      // 停用或隐藏时清空排期，重新启用后从头计时。
      schedule.current = emptySchedule();
      return;
    }
    let cancelled = false;
    let timer = 0;

    const arm = (waitMs: number) => {
      if (cancelled) return;
      schedule.current = reschedule(
        schedule.current,
        Date.now(),
        waitMs / 1000,
      );
      timer = window.setTimeout(
        () => {
          if (cancelled) return;
          schedule.current = { ...schedule.current, running: true, dueAt: 0 };
          // 暂停通道：不联网，但仍要保留轮询，凭据恢复后才能重新纳入。
          if (paused) {
            schedule.current = { ...schedule.current, running: false };
            arm(Math.min(300, delaySeconds) * 1000);
            return;
          }
          void runRef
            .current()
            .finally(() => {
              schedule.current = { ...schedule.current, running: false };
              arm(delaySeconds * 1000);
            })
            .catch(() => undefined);
        },
        Math.max(0, waitMs),
      );
    };

    // 本通道排期：首次按当前延迟，之后每次请求结束再排下一次。
    arm(delaySeconds * 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      schedule.current = emptySchedule();
    };
    // revision 让同一通道在状态变化后重排；其他通道的 revision 不在依赖里。
  }, [enabled, visible, paused, delaySeconds, revision]);

  return {
    /** 该通道当前的截止时间（毫秒）；0 表示未排期。 */
    dueAt: () => schedule.current.dueAt,
    isDue: () => isDue(schedule.current, Date.now()),
    remainingMs: () => msUntilDue(schedule.current, Date.now()),
  };
}
