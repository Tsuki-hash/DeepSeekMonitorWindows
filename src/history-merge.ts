// 历史分批请求的结果合并。
//
// 复评 F02：原实现里「重试失败月份」从空数组开始，替换快照后丢失此前成功的月份，
// 影响合计与导出；「继续加载更早」又只在 older 分支保留旧结果。
// 提前停止时还把**计划**目标当作已请求，未尝试的月份被误标成「平台未返回」。
//
// 这里把合并与边界计算收敛成纯函数：按月份索引合并，区分
// planned（计划请求）/ attempted（真正尝试过）/ successful / failed / unloaded。

import type { HistoryMonth } from "./history";

export type MergeInput = {
  /** 窗口内全部月份（升序）。 */
  windowMonths: string[];
  /** 本次计划请求的月份。 */
  planned: string[];
  /** 本次真正尝试过（含失败）的月份。 */
  attempted: string[];
  /** 本次成功取得的月份。 */
  successful: HistoryMonth[];
  /** 此前已有的成功月份（重试/继续加载时传入）。 */
  previous: HistoryMonth[];
  /** 失败月份。 */
  failed: string[];
};

export type MergeResult = {
  /** 合并后的月份，按月份升序、按月去重（本次结果覆盖旧值）。 */
  months: HistoryMonth[];
  /** 已覆盖到的最早月份；null 表示尚未覆盖任何月份。 */
  coveredFrom: string | null;
  /** 窗口内尚未加载的月份：早于已覆盖范围、且本次未尝试的月份。 */
  unloaded: string[];
};

export function mergeHistoryMonths(input: MergeInput): MergeResult {
  const { windowMonths, attempted, successful, previous, failed } = input;
  const byMonth = new Map<string, HistoryMonth>();
  // 旧结果先入表；本次结果按月份覆盖同名项，避免「重试成功反被旧值盖住」。
  for (const month of previous) byMonth.set(month.month, month);
  for (const month of successful) byMonth.set(month.month, month);
  const months = [...byMonth.values()].sort((a, b) =>
    a.month.localeCompare(b.month),
  );

  const attemptedSet = new Set(attempted);
  const failedSet = new Set(failed);
  // 已覆盖范围：本次成功的最早月份与旧结果的最早月份取更早者。
  // 只看「成功」的月份——失败月份没有数据，边界不能越过它。
  const successfulMonths = successful.map((month) => month.month);
  const previousMonths = previous.map((month) => month.month);
  const coveredFrom =
    [...successfulMonths, ...previousMonths].sort()[0] ?? null;

  const unloaded = windowMonths.filter((month) => {
    if (attemptedSet.has(month)) return false; // 本次尝试过（成功或失败）都不算未加载
    if (failedSet.has(month)) return false;
    if (coveredFrom == null) return true; // 还没有任何成功数据：全部未加载
    // 早于已覆盖范围、且从未尝试过的月份才是未加载。
    return month < coveredFrom;
  });

  // 无论重试、扩展还是首次加载，旧结果都保留：本次结果只按月份覆盖同名项，
  // 这样「只重试失败月份」不会抹掉其他成功月份。
  return { months, coveredFrom, unloaded };
}
