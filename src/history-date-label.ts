// 历史日期显示口径。
//
// 评审 P2：每日明细统一用 `mmdd`，跨年同一模型的不同日期会显示成相同的「1/1」。
// 原始数据与导出保留完整日期，缺口只在展示。这里把规则抽成纯函数便于测试。

/**
 * 区间跨年时用完整日期（`2025-01-01`），单年内仍用短格式（`1/1`）。
 *
 * 判据是**区间**而不是单条日期：同一张表里如果一半短一半长，会更难扫读。
 */
export function historyDateLabel(
  date: string,
  from: string,
  to: string,
  short: (value: string) => string,
): string {
  const spansYears = from.slice(0, 4) !== to.slice(0, 4);
  return spansYears ? date : short(date);
}
