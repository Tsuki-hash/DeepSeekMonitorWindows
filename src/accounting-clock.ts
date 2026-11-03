// 平台记账日期的变化驱动。
//
// 评审 P1：自动刷新关闭时，面板可能一直开着跨过北京时间月界，而首页仍把上个月的
// 累计叫作「本月消费」——因为刷新只在加载/成功/失败路径被触发，没有任何东西观察
// 「记账日期变了」这件事。
//
// 这里只做纯计算：下一次记账日切换还有多久。调度由调用方负责，便于单测。

const BEIJING_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

/**
 * 距离下一个东八区 00:00 的毫秒数。
 *
 * 返回值恒在 `(0, 24h]`：恰好落在零点时返回整天，而不是 0。调用方拿到 0 就会立刻
 * 重排下一次定时器形成空转，而这一刻的日期本身已经是新的，没必要马上再取一次。
 * 非法时间返回整天，宁可晚一天检查也不空转。
 */
export function msUntilNextAccountingDate(now: Date = new Date()): number {
  const current = now.getTime();
  if (!Number.isFinite(current)) return DAY_MS;
  const shifted = current + BEIJING_OFFSET_MS;
  const remainder = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  return remainder === 0 ? DAY_MS : DAY_MS - remainder;
}
