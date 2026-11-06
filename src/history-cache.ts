import type { UsageResult } from "./types";
import type { HistoryMonth } from "./history";
import { todayStr } from "./format.ts";

export class HistoryCache {
  private generation = 0;
  private cache = new Map<string, HistoryMonth>();
  private pending = new Map<string, Promise<HistoryMonth>>();
  private listeners = new Set<() => void>();
  epoch = () => this.generation;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  invalidate() {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    this.listeners.forEach((listener) => listener());
  }
  async get(
    month: string,
    loader: () => Promise<UsageResult>,
    force = false,
    now = Date.now,
    /** 复评 T10：注入记账日（默认真实东八区当天）。 */
    accountingDate = () => todayStr(),
  ): Promise<HistoryMonth> {
    // 复评 T10：请求发起前捕获记账日 —— 本月缓存一旦跨过这个日期就必须
    // 重拉，不能用「响应完成时刻」给旧请求贴新标签。
    const sourceAsOfDate = accountingDate();
    const cached = this.cache.get(month);
    const currentMonth = sourceAsOfDate.slice(0, 7);
    if (
      !force &&
      cached &&
      now() - cached.fetchedAt >= 0 &&
      now() - cached.fetchedAt < 300000 &&
      // 跨记账午夜：本月缓存的窗口上界已过期。
      !(month === currentMonth && cached.sourceAsOfDate !== sourceAsOfDate)
    )
      return cached;
    if (!force && this.pending.has(month)) return this.pending.get(month)!;
    const generation = this.generation;
    const task = Promise.resolve()
      .then(loader)
      .then((usage) => {
        if (generation !== this.generation || this.pending.get(month) !== task)
          throw new Error("用量会话已变化，请重新查询");
        const value = { month, usage, fetchedAt: now(), sourceAsOfDate };
        this.cache.set(month, value);
        while (this.cache.size > 4)
          this.cache.delete(this.cache.keys().next().value!);
        return value;
      })
      .finally(() => {
        if (this.pending.get(month) === task) this.pending.delete(month);
      });
    this.pending.set(month, task);
    return task;
  }
}
export const historyCache = new HistoryCache();
