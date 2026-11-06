import React from "react";
import { Brain, Shapes, Zap, X } from "lucide-react";
import {
  chartPointFromDay,
  fmtInt,
  fmtMoney,
  fmtMoneyDisplay,
  mmdd,
  recentUsageDays,
} from "../format";
import type { LoadState, ModelName, UsageResult } from "../types";
import { updateTime } from "../data-display";
import { usageNotices } from "../usage-notices";
import { sumUsageCounts } from "../usage-counts";
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
  // 费用/请求数为 null 表示未取得：显示「—」，不能显示成 ¥0.00 / 0。
  const cost = data?.cost != null ? fmtMoneyDisplay(data.cost) : "—";
  // 月数值只读月槽位；下方日图表即使完整，也不能代替平台月汇总。
  const totalTokens = sumUsageCounts([data?.totalTokens]).total;
  const totalText = totalTokens == null ? "未知" : fmtInt(totalTokens);
  const monthValueId = React.useId();
  const monthSourceId = React.useId();

  const now = new Date();
  const days = recentUsageDays(
    usage?.days ?? [],
    7,
    usage?.unavailableDates,
    now,
    usage?.accountingDate,
  );
  const points = days.map((day) =>
    chartPointFromDay(day, isFlash ? "flash" : isOther ? "other" : "pro"),
  );
  const notices = usageNotices(usage, now);
  const hasUnknown =
    usageState === "ok" && points.some((point) => point.unavailable);
  const hasOther = points.some(
    (point) =>
      (point.other ?? 0) > 0 ||
      (point.unavailableReason != null && point.other == null),
  );
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
      <div
        className="detail-scroll"
        role="region"
        aria-label={`${title} 用量详情`}
        tabIndex={0}
      >
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
          <article
            className="card metric-card"
            data-testid="month-token-metric"
            role="group"
            tabIndex={0}
            aria-label={`${title}，平台本月 Tokens 完整数值`}
            aria-describedby={`${monthValueId} ${monthSourceId}`}
          >
            <span>本月 Tokens</span>
            <strong
              id={monthValueId}
              className={`${tintClass} month-token-exact`}
            >
              {totalText}
            </strong>
            <small id={monthSourceId} className="month-source-note">
              完整数值 · 平台月汇总，非近 7 日合计
            </small>
          </article>
        </div>

        <article className="card detail-chart">
          <div className="detail-chart-head">
            <div>
              <h2>按日 Token 消耗</h2>
              <span>{rangeText}</span>
              {(notices.length > 0 ||
                hasUnknown ||
                (usageError && usageState !== "nokey") ||
                updatedAt) && (
                <button className="data-status-link" onClick={onDataStatus}>
                  {usageError
                    ? "更新失败 ›"
                    : notices.length || hasUnknown
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
      </div>
    </section>
  );
}
export { ModelDetailPanel };
