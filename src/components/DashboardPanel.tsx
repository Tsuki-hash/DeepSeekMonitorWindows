import React from "react";
import { RefreshCw, Settings, Shirt, X } from "lucide-react";
import { todayStr } from "../format";
import type { BalanceData, LoadState, ModelName, UsageResult } from "../types";
import { useTheme } from "../theme";
import { BrandIcon } from "./BrandIcon";
import { BalanceCard } from "./BalanceCard";
import { UsageRow } from "./UsageRow";
import { UsageChart } from "./UsageChart";

function DashboardPanel({
  balanceUpdatedAt,
  usageUpdatedAt,
  balance,
  balanceState,
  balanceError,
  usage,
  usageState,
  usageError,
  onRefresh,
  onClose,
  onSettings,
  onDataStatus,
  onDetail,
  onHistory,
}: {
  balanceUpdatedAt?: number | null;
  usageUpdatedAt?: number | null;
  balance: BalanceData | null;
  balanceState: LoadState;
  balanceError: string;
  usage: UsageResult | null;
  usageState: LoadState;
  usageError: string;
  onRefresh: () => void;
  onClose: () => void;
  onSettings: () => void;
  onDataStatus?: () => void;
  onDetail: (model: ModelName) => void;
  onHistory: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  // 手动刷新路径会把状态打回 loading；静默刷新保持 ok 不转，避免托盘唤出时图标常转
  const loading = balanceState === "loading" || usageState === "loading";
  const flash = usage?.models.find((item) => item.key === "flash") ?? null;
  const pro = usage?.models.find((item) => item.key === "pro") ?? null;
  const other = usage?.models.find((item) => item.key === "other") ?? null;
  const maxTokens = Math.max(
    flash?.totalTokens ?? 0,
    pro?.totalTokens ?? 0,
    other?.totalTokens ?? 0,
    1,
  );
  const today = usage?.days.find((day) => day.date === todayStr()) ?? null;
  const todayCost = usageState === "ok" && today ? today.totalCost : null;
  const monthCost = usageState === "ok" && usage ? usage.monthCost : null;

  return (
    <section className="panel dashboard-panel" data-testid="dashboard-panel">
      <header className="panel-header" data-tauri-drag-region>
        <div className="title-lockup" data-tauri-drag-region>
          <BrandIcon size={36} />
          <h1>DeepSeek Monitor</h1>
        </div>
        <div className="header-actions">
          <button aria-label="刷新" onClick={onRefresh}>
            <RefreshCw
              size={20}
              className={loading ? "refresh-spin" : undefined}
            />
          </button>
          <div className="skin-menu-wrap">
            <button
              aria-label="切换主题"
              className="skin-toggle"
              title={theme === "dark" ? "切换浅色" : "切换深色"}
              onClick={toggleTheme}
            >
              <Shirt size={20} />
            </button>
          </div>
          <button aria-label="设置" onClick={onSettings}>
            <Settings size={20} />
          </button>
          <button
            aria-label="关闭"
            title="收起到托盘，右键托盘图标可退出"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </header>

      <BalanceCard
        updatedAt={balanceUpdatedAt}
        onSettings={onSettings}
        onDataStatus={onDataStatus ?? onSettings}
        balance={balance}
        state={balanceState}
        error={balanceError}
        todayCost={todayCost}
        monthCost={monthCost}
      />

      <div className="usage-stack">
        <UsageRow
          modelKey="flash"
          data={flash}
          maxTokens={maxTokens}
          state={usageState}
          onClick={() => onDetail("flash")}
        />
        <UsageRow
          modelKey="pro"
          data={pro}
          maxTokens={maxTokens}
          state={usageState}
          onClick={() => onDetail("pro")}
        />
        {other && (
          <UsageRow
            modelKey="other"
            data={other}
            maxTokens={maxTokens}
            state={usageState}
            onClick={() => onDetail("other")}
          />
        )}
      </div>

      <UsageChart
        onHistory={onHistory}
        usage={usage}
        state={usageState}
        error={usageError}
        updatedAt={usageUpdatedAt}
        onSettings={onSettings}
        onDataStatus={onDataStatus ?? onSettings}
      />
    </section>
  );
}
export { DashboardPanel };
