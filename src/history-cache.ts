import type { UsageResult } from "./types";
import type { HistoryMonth } from "./history";
import { todayStr } from "./format.ts";
import { classifyHistoryFailure } from "./history-failure.ts";
import type { HistoryFailure } from "./history-failure.ts";

/** A failed refresh never turns the last successful payload into a success. */
export class HistoryCacheFailure extends Error {
  readonly month: string;
  readonly epoch: number;
  readonly classified: HistoryFailure;
  readonly lastSuccess: HistoryMonth | undefined;
  readonly hadSuccess: boolean;

  constructor(
    month: string,
    epoch: number,
    classified: HistoryFailure,
    lastSuccess: HistoryMonth | undefined,
    hadSuccess: boolean,
  ) {
    super("历史月份查询失败");
    this.name = "HistoryCacheFailure";
    this.month = month;
    this.epoch = epoch;
    this.classified = classified;
    this.lastSuccess = lastSuccess;
    this.hadSuccess = hadSuccess;
  }
}

type PendingMonth = {
  task: Promise<HistoryMonth>;
  supersede: (replacement: Promise<HistoryMonth>) => void;
};

type FailedMonth = {
  classified: HistoryFailure;
  hadSuccess: boolean;
  failedAt: number;
  sourceAsOfDate: string;
};

const safeFailureMessages: Record<HistoryFailure["kind"], string> = {
  config: "本地配置读取失败，原文件未改动，请修复后重新读取配置。",
  auth: "用量凭据需要配置或重新同步。",
  transient: "用量接口暂时不可用，请稍后重试。",
  month: "该月份用量查询失败，请重试。",
};

export class HistoryCache {
  private generation = 0;
  private cache = new Map<string, HistoryMonth>();
  // Keep payloads bounded to four months. Lightweight outcome metadata outlives
  // payload eviction, so an evicted failed month is still failed/unknown, never
  // a successful zero. Only an owned loader success (or credential epoch change)
  // clears failure, not a TTL hit, navigation or eviction.
  private failures = new Map<string, FailedMonth>();
  private successfulMonths = new Set<string>();
  private pending = new Map<string, PendingMonth>();
  private active = new Map<string, Set<PendingMonth>>();
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
    this.failures.clear();
    this.successfulMonths.clear();
    this.pending.clear();
    this.active.clear();
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
    const failure = this.failures.get(month);
    const cached = this.cache.get(month);
    const currentMonth = sourceAsOfDate.slice(0, 7);
    // A new consumer joins the latest real attempt before looking at an older
    // cached outcome. In particular, remounting during a retry follows it.
    if (!force && this.pending.has(month)) return this.pending.get(month)!.task;
    const instant = now();
    const fresh = (fetchedAt: number, asOf: string | undefined) =>
      instant - fetchedAt >= 0 &&
      instant - fetchedAt < 300000 &&
      // 跨记账午夜：本月缓存的窗口上界已过期。
      !(month === currentMonth && asOf !== sourceAsOfDate);
    if (
      !force &&
      failure?.hadSuccess &&
      fresh(failure.failedAt, failure.sourceAsOfDate)
    )
      throw new HistoryCacheFailure(
        month,
        this.generation,
        failure.classified,
        cached,
        true,
      );
    if (
      !force &&
      !failure &&
      cached &&
      fresh(cached.fetchedAt, cached.sourceAsOfDate)
    )
      return cached;
    const generation = this.generation;
    // Explicit refreshes supersede, rather than deduplicate, older requests.
    // Their consumers follow the replacement result, even if it has already
    // settled and left pending. A late failure cannot overwrite a newer success
    // (and a late success cannot erase a newer failure).
    let replacement: Promise<HistoryMonth> | undefined;
    const task: Promise<HistoryMonth> = Promise.resolve()
      .then(() => {
        if (generation !== this.generation)
          throw new Error("用量会话已变化，请重新查询");
        return loader();
      })
      .then(
        (usage): HistoryMonth | Promise<HistoryMonth> => {
          if (generation !== this.generation)
            throw new Error("用量会话已变化，请重新查询");
          if (replacement) return replacement;
          const value = { month, usage, fetchedAt: now(), sourceAsOfDate };
          this.cache.set(month, value);
          this.successfulMonths.add(month);
          this.failures.delete(month);
          while (this.cache.size > 4)
            this.cache.delete(this.cache.keys().next().value!);
          return value;
        },
        (original): Promise<HistoryMonth> => {
          if (generation !== this.generation)
            throw new Error("用量会话已变化，请重新查询");
          if (replacement) return replacement;
          const hadSuccess = this.successfulMonths.has(month);
          // Classify the full error transiently (including legacy auth text),
          // then retain only its kind and fixed safe text. IPC/network/parser
          // messages are not guaranteed to be redacted: even a truncated message
          // could retain a credential or response body. Never cache that text or
          // arbitrary error fields that could pin an evicted month's payload.
          const { kind } = classifyHistoryFailure(original, month);
          const classified: HistoryFailure = {
            kind,
            month,
            message: safeFailureMessages[kind],
          };
          this.failures.set(month, {
            classified,
            hadSuccess,
            failedAt: now(),
            sourceAsOfDate,
          });
          throw new HistoryCacheFailure(
            month,
            generation,
            classified,
            cached,
            hadSuccess,
          );
        },
      )
      .finally(() => {
        if (this.pending.get(month)?.task === task) this.pending.delete(month);
        const remaining = this.active.get(month);
        remaining?.delete(owner);
        if (remaining?.size === 0) this.active.delete(month);
      });
    const owner: PendingMonth = {
      task,
      supersede: (next) => {
        replacement = next;
      },
    };
    // Keep track of every still-unsettled consumer, not just pending's newest
    // request. A -> B settles -> C starts -> A settles must follow C, not B.
    const active = this.active.get(month) ?? new Set<PendingMonth>();
    active.forEach((older) => older.supersede(task));
    active.add(owner);
    this.active.set(month, active);
    this.pending.set(month, owner);
    return task;
  }
}
export const historyCache = new HistoryCache();
