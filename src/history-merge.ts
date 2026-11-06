// 历史分批请求的结果合并。
//
// 复评 F02：原实现里「重试失败月份」从空数组开始，替换快照后丢失此前成功的月份，
// 影响合计与导出；「继续加载更早」又只在 older 分支保留旧结果。
// 提前停止时还把**计划**目标当作已请求，未尝试的月份被误标成「平台未返回」。
//
// 复评 R02：合并器无条件保留旧月份，切范围（本月→上月）后旧月份会混进新窗口的
// 月汇总与 JSON；跨账户时旧账户月份还可能被重新标上新 epoch。
// 因此这里增加**作用域身份**：只有同一 scope（区间 + 窗口 + 凭据代际）的结果
// 才允许继承，且输出一律按窗口过滤。
//
// 复评 R05：失败月份必须跨批次持久，只有本次成功才能清除该月的旧失败状态。

import type { HistoryMonth } from "./history";

/** 一次历史查询的身份：区间、窗口与凭据代际。 */
export type HistoryScope = {
  /** 区间类型（month/previous/30days/custom/all）。 */
  range: string;
  /** 窗口起止。 */
  from: string;
  /** 窗口止。 */
  to: string;
  /** 凭据代际：账号/Token 变化时递增，用于账户隔离。 */
  epoch: number;
};

/** 两个作用域是否可继承。 */
export function sameScope(a: HistoryScope, b: HistoryScope): boolean {
  return (
    a.range === b.range &&
    a.from === b.from &&
    a.to === b.to &&
    a.epoch === b.epoch
  );
}

export type MergeInput = {
  /** 本次请求的作用域。 */
  scope: HistoryScope;
  /** 旧结果所属作用域；null 表示没有旧结果。 */
  previousScope: HistoryScope | null;
  /** 窗口内全部月份（升序）。 */
  windowMonths: string[];
  /** 本次计划请求的月份。 */
  planned: string[];
  /** 本次已发起请求的月份；没有成功/失败结果的在途月份不推进边界。 */
  attempted: string[];
  /** 本次成功取得的月份。 */
  successful: HistoryMonth[];
  /** 此前已有的成功月份（重试/继续加载时传入）。 */
  previous: HistoryMonth[];
  /** 本次失败月份。 */
  failed: string[];
  /** 此前累计的失败月份（跨批次持久）。 */
  previousFailed: string[];
};

export type MergeResult = {
  /** 合并后的月份，按月份升序、按月去重（本次结果覆盖旧值）。 */
  months: HistoryMonth[];
  /** 已覆盖到的最早月份；null 表示尚未覆盖任何月份。 */
  coveredFrom: string | null;
  /** 已完成查询（成功或失败）的最早月份；与成功覆盖边界独立。 */
  attemptedFrom: string | null;
  /** 窗口内没有已提交结果的月份，包含更早月份和跨月产生的较新空洞。 */
  unloaded: string[];
  /** 累计失败月份（含前批次）：只有本次成功才从列表移除。 */
  failedMonths: string[];
};

export function mergeHistoryMonths(input: MergeInput): MergeResult {
  const {
    scope,
    previousScope,
    windowMonths,
    attempted,
    successful,
    previous,
    failed,
    previousFailed,
  } = input;

  // 复评 R02：作用域不一致时**不继承**旧月份（切范围/换账户）。
  const canInherit = previousScope != null && sameScope(scope, previousScope);
  const inheritable = canInherit ? previous : [];

  const windowSet = new Set(windowMonths);
  const byMonth = new Map<string, HistoryMonth>();
  for (const month of inheritable) {
    // 防御性过滤：即使作用域一致，窗口外的月份也不能进入结果。
    if (windowSet.has(month.month)) byMonth.set(month.month, month);
  }
  for (const month of successful) {
    if (windowSet.has(month.month)) byMonth.set(month.month, month);
  }
  const months = [...byMonth.values()].sort((a, b) =>
    a.month.localeCompare(b.month),
  );

  // 复评 R05：失败状态跨批次累积，只有本次**成功**才清除对应月份。
  const succeededThisRun = new Set(successful.map((month) => month.month));
  const failedSet = new Set(
    [...(canInherit ? previousFailed : []), ...failed].filter(
      (month) => !succeededThisRun.has(month) && windowSet.has(month),
    ),
  );

  const coveredFrom = months[0]?.month ?? null;

  // Success coverage and pagination are different facts. Even a whole batch
  // of month-level failures advances the cursor, but keeps every failed month
  // retryable. Planned/in-flight months must not become covered or missing.
  const completedAttempts = attempted.filter(
    (month) => succeededThisRun.has(month) || failedSet.has(month),
  );
  const accounted = new Set([
    ...months.map((month) => month.month),
    ...failedSet,
    ...completedAttempts.filter((month) => windowSet.has(month)),
  ]);
  const attemptedFrom = [...accounted].sort()[0] ?? null;
  const unloaded = windowMonths.filter((month) => !accounted.has(month));

  return {
    months,
    coveredFrom,
    attemptedFrom,
    unloaded,
    failedMonths: [...failedSet].sort(),
  };
}
