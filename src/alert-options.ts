export type AlertOptions = {
  enabled: boolean;
  lowBalanceEnabled: boolean;
  lowBalanceCny: number;
  monthlyBudgetEnabled: boolean;
  monthlyBudgetCny: number;
  quietHours: boolean;
};
export type AlertStatus = {
  options: AlertOptions;
  balanceState: string;
  budgetState: string;
  balanceCheckedAt: number | null;
  budgetCheckedAt: number | null;
  lastNotificationAt: number | null;
  quietNow: boolean;
  error: string | null;
};
export function alertAmounts(low: string, budget: string) {
  const lowBalanceCny = low.trim() ? Number(low) : NaN;
  const monthlyBudgetCny = budget.trim() ? Number(budget) : NaN;
  if (
    !Number.isFinite(lowBalanceCny) ||
    lowBalanceCny < 0 ||
    lowBalanceCny > 1e9
  )
    throw new Error("余额提醒线需为0至10亿元之间的金额");
  if (
    !Number.isFinite(monthlyBudgetCny) ||
    monthlyBudgetCny <= 0 ||
    monthlyBudgetCny > 1e9
  )
    throw new Error("月预算需大于0且不超过10亿元");
  return { lowBalanceCny, monthlyBudgetCny };
}
export function alertDraftAmounts(
  draft: AlertOptions,
  saved: AlertOptions,
  low: string,
  budget: string,
) {
  return alertAmounts(
    draft.enabled && draft.lowBalanceEnabled
      ? low
      : String(saved.lowBalanceCny),
    draft.enabled && draft.monthlyBudgetEnabled
      ? budget
      : String(saved.monthlyBudgetCny),
  );
}
export function alertStateLabel(state: string, source: "balance" | "budget") {
  const labels: Record<string, string> = {
    disabled: "未开启",
    missing: source === "balance" ? "请先配置 API Key" : "请先同步用量 Token",
    waiting: "等待首次检查",
    checking: "检查中…",
    ok: "检查成功",
    credentials_invalid:
      source === "balance" ? "Key 失效，请重新配置" : "Token 失效，请重新同步",
    unavailable: "查询失败，将退避重试",
    rate_limited: "请求受限，将退避重试",
    unsupported: "仅支持人民币余额",
    invalid_data: "数据待核对，不发送提醒",
  };
  return labels[state] || "暂未取得有效数据";
}
