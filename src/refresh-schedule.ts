// 刷新调度的纯计算部分。
//
// 复评 R01：两路自动刷新共享一个 `scheduleRevision`，任一通道完成都会递增它，
// effect 随即清除**两路** timer 并重新倒计时。于是余额每 60 秒成功一次，
// 就不断把用量的 120 秒退避推迟，用量可能永远等不到重试。
//
// 修法是把「什么时候该跑」变成每通道独立的绝对截止时间：另一个通道完成
// 不得推迟已有截止时间。这里只放纯计算，调度与 effect 留在 App。

/** 通道的调度状态：绝对截止时间 + 是否在跑。 */
export type ChannelSchedule = {
  /** 下次应执行的绝对时间戳（毫秒）；0 表示尚未排期。 */
  dueAt: number;
  /** 是否有请求在途：在途期间不重复排期。 */
  running: boolean;
};

export const emptySchedule = (): ChannelSchedule => ({
  dueAt: 0,
  running: false,
});

/** 从现在起 `delaySeconds` 秒后的绝对时间；delay<=0 表示立刻。 */
export function dueAtFrom(now: number, delaySeconds: number): number {
  const delay = Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 0;
  return now + delay * 1000;
}

/** 该通道是否已到期。 */
export function isDue(schedule: ChannelSchedule, now: number): boolean {
  return schedule.dueAt > 0 && now >= schedule.dueAt;
}

/**
 * 重新排期：保持「在途」标记不变，只更新截止时间。
 *
 * 注意这是**单个通道**的操作 —— 调用方不得用它影响另一个通道的截止时间。
 */
export function reschedule(
  schedule: ChannelSchedule,
  now: number,
  delaySeconds: number,
): ChannelSchedule {
  return { ...schedule, dueAt: dueAtFrom(now, delaySeconds) };
}

/** 距离该通道到期还有多少毫秒（已到期或未排期返回 0）。 */
export function msUntilDue(schedule: ChannelSchedule, now: number): number {
  if (schedule.dueAt <= 0) return 0;
  return Math.max(0, schedule.dueAt - now);
}
