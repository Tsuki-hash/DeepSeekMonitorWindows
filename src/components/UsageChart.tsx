import React from "react";
import { BarChart3 } from "lucide-react";
import { chartPointFromDay, fmtTokensShort, recentUsageDays } from "../format";
import type { LoadState, UsageResult } from "../types";
import { updateTime } from "../data-display";
import { usageNotices } from "../usage-notices";
import { StackedBarChart } from "./StackedBarChart";

function UsageChart({
  updatedAt,
  onSettings,
  usage,
  state,
  error,
  onDataStatus,
  onHistory,
}: {
  updatedAt?: number | null;
  onSettings?: () => void;
  usage: UsageResult | null;
  state: LoadState;
  error: string;
  onDataStatus?: () => void;
  onHistory?: () => void;
}) {
  const days = recentUsageDays(usage?.days ?? [], 7, usage?.unavailableDates);
  // all：合计含未识别模型（差额并入 other），避免按日图静默丢量
  const points = days.map((day) => chartPointFromDay(day, "all"));
  const notices = usageNotices(usage);
  const hasOther = points.some((point) => point.other > 0);
  const sumHit = points.reduce((sum, point) => sum + point.hit, 0);
  const sumMiss = points.reduce((sum, point) => sum + point.miss, 0);
  const sumTotal = points.reduce((sum, point) => sum + point.total, 0);
  const hitRate =
    sumHit + sumMiss > 0
      ? ((sumHit / (sumHit + sumMiss)) * 100).toFixed(0)
      : "—";
  const placeholder =
    state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置用量 Token，可在设置页同步或粘贴"
        : state === "error"
          ? error || "用量查询失败，余额不受影响"
          : "暂无数据";

  return (
    <article className="card chart-card">
      <div className="card-title-row">
        <button
          className="caption-with-icon history-entry"
          aria-label="用量历史"
          title="查看历史查询与导出"
          onClick={onHistory}
        >
          <BarChart3 size={16} className="brand-blue" />
          <span title={`输入缓存命中率 ${hitRate}%（命中 / 已知输入）`}>
            近7日 Tokens ›
          </span>
        </button>
        <span className="chart-total">
          {error && state !== "nokey" ? (
            <button className="data-status-link" onClick={onDataStatus}>
              更新失败 ›
            </button>
          ) : notices.length > 0 ? (
            <button className="data-status-link" onClick={onDataStatus}>
              数据待核对 ›
            </button>
          ) : state === "ok" ? (
            <>
              {fmtTokensShort(sumTotal)} ·{" "}
              <button
                className="data-status-link"
                onClick={onDataStatus}
                title="查看数据更新时间与统计口径"
              >
                {updateTime(updatedAt)} ›
              </button>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
      {state === "ok" && points.length > 0 ? (
        <StackedBarChart
          points={points}
          variant="summary"
          hasOther={hasOther}
        />
      ) : (
        <div className="chart-placeholder">
          {state === "nokey" ? (
            <button className="empty-settings" onClick={onSettings}>
              同步用量 Token ›
            </button>
          ) : (
            placeholder
          )}
        </div>
      )}
    </article>
  );
}
export { UsageChart };
