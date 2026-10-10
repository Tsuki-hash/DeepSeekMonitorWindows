import type { UsageResult } from "./types";
import type { HistoryMonth } from "./history";

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
  ): Promise<HistoryMonth> {
    const cached = this.cache.get(month);
    if (
      !force &&
      cached &&
      now() - cached.fetchedAt >= 0 &&
      now() - cached.fetchedAt < 300000
    )
      return cached;
    if (!force && this.pending.has(month)) return this.pending.get(month)!;
    const generation = this.generation;
    const task = Promise.resolve()
      .then(loader)
      .then((usage) => {
        if (generation !== this.generation || this.pending.get(month) !== task)
          throw new Error("用量会话已变化，请重新查询");
        const value = { month, usage, fetchedAt: now() };
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
