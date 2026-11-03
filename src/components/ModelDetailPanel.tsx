import React from "react";
import { Brain, Shapes, Zap, X } from "lucide-react";
import {
  chartPointFromDay,
  fmtInt,
  fmtMoney,
  fmtMoneyDisplay,
  fmtTokensShort,
  mmdd,
  recentUsageDays,
} from "../format";
import type { LoadState, ModelName, UsageResult } from "../types";
import { updateTime } from "../data-display";
import { usageNotices } from "../usage-notices";
import { StackedBarChart } from "./StackedBarChart";

function ModelDetailPanel({
  updatedAt,
  onSettings,
  model,
  usage,
  usageState,
  usageError,
  onBack,
  onDataStatus,
}: {
  updatedAt?: number | null;
  onSettings?: () => void;
  model: ModelName;
  usage: UsageResult | null;
  usageState: LoadState;
  usageError: string;
  onBack: () => void;
  onDataStatus?: () => void;
}) {
  const isFlash = model === "flash";
  const isOther = model === "other";
  const data = usage?.models.find((item) => item.key === model) ?? null;
  // 显示名以后端 model_slot 为准，避免前后端双源漂移
  const title =
    data?.name ?? (isFlash ? "V4.1 Flash" : isOther ? "其他" : "V4 Pro");
  const tintClass = isFlash ? "flash" : isOther ? "other" : "pro";
  // 费用/计数为 null 表示未取得：显示「—」，不能显示成 ¥0.00 / 0 Tokens。
  const cost = data?.cost != null ? fmtMoneyDisplay(data.cost) : "—";
  const totalText =
    data?.totalTokens != null ? fmtTokensShort(data.totalTokens) : "—";

  const days = recentUsageDays(usage?.days ?? [], 7, usage?.unavailableDates);
  const points = days.map((day) =>
    chartPointFromDay(day, isFlash ? "flash" : isOther ? "other" : "pro"),
  );
  const notices = usageNotices(usage);
  const hasOther = points.some((point) => point.other > 0);
  const rangeText =
    points.length > 0
      ? `${mmdd(points[0].date)} - ${mmdd(points[points.length - 1].date)}`
      : "";

  return (
    <section className="panel detail-panel" data-testid="detail-panel">
      <button
        className="floating-close"
        onClick={onBack}
        aria-label="返回主面板"
      >
        <X size={20} />
      </button>
      <article className="card detail-hero" data-tauri-drag-region>
        <div className={`model-badge large ${tintClass}`}>
          {isFlash ? (
            <Zap size={34} fill="currentColor" />
          ) : isOther ? (
            <Shapes size={31} />
          ) : (
            <Brain size={33} />
          )}
        </div>
        <div>
          <h1 title={title}>{title}</h1>
          <p title={data?.cost != null ? fmtMoney(data.cost) : undefined}>
            本月 · {cost}
          </p>
        </div>
      </article>

      <div className="detail-metrics">
        <article className="card metric-card">
          <span>本月请求次数</span>
          <strong className={tintClass}>
            {data?.requestCount != null ? fmtInt(data.requestCount) : "—"}
          </strong>
        </article>
        <article className="card metric-card">
          <span>本月 Tokens</span>
          <strong className={tintClass}>{totalText}</strong>
        </article>
      </div>

      <article className="card detail-chart">
        <div className="detail-chart-head">
          <div>
            <h2>按日 Token 消耗</h2>
            <span>{rangeText}</span>
            {(notices.length > 0 ||
              (usageError && usageState !== "nokey") ||
              updatedAt) && (
              <button className="data-status-link" onClick={onDataStatus}>
                {usageError
                  ? "更新失败 ›"
                  : notices.length
                    ? "数据待核对 ›"
                    : `${updateTime(updatedAt)} 更新 ›`}
              </button>
            )}
          </div>
        </div>
        {usageState === "ok" && points.length > 0 ? (
          <StackedBarChart
            points={points}
            variant="detail"
            hasOther={hasOther}
          />
        ) : (
          <div className="chart-placeholder">
            {usageState === "nokey" && (
              <button className="empty-settings" onClick={onSettings}>
                同步用量 Token ›
              </button>
            )}
            {usageState === "nokey"
              ? ""
              : usageState === "loading"
                ? "查询中…"
                : usageState === "error"
                  ? usageError || "用量不可用"
                  : "暂无数据"}
          </div>
        )}
      </article>
    </section>
  );
}
export { ModelDetailPanel };
