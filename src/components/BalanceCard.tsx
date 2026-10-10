import React from "react";
import { CalendarDays, CreditCard, SunMedium } from "lucide-react";
import { currencySymbol, fmtMoney, fmtMoneyDisplay } from "../format";
import { updateTime } from "../data-display";
import type { BalanceData, LoadState } from "../types";
import { PricingPeriodBadge } from "./PricingPeriodBadge";

function BalanceCard({
  updatedAt,
  onSettings,
  onDataStatus,
  balance,
  state,
  error,
  todayCost,
  monthCost,
}: {
  updatedAt?: number | null;
  onSettings?: () => void;
  onDataStatus?: () => void;
  balance: BalanceData | null;
  state: LoadState;
  error: string;
  todayCost: number | null;
  monthCost: number | null;
}) {
  const symbol = currencySymbol(balance?.currency);
  const amount =
    state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置"
        : state === "error"
          ? "查询失败"
          : fmtMoneyDisplay(Number(balance?.totalBalance ?? "0"), symbol);
  const statusText =
    state === "ok" ? (balance?.isAvailable ? "可用" : "余额不足") : "—";
  const statusOff = state === "ok" && balance != null && !balance.isAvailable;
  // 卡片顶部的状态灯与状态胶囊同源，给面板一个一眼可读的仪表指示灯
  const railState =
    state === "ok"
      ? statusOff
        ? "warn"
        : "ok"
      : state === "error"
        ? "danger"
        : "idle";

  return (
    <article className={`card balance-card rail-${railState}`}>
      <div className="card-title-row">
        <div className="caption-with-icon">
          <CreditCard size={15} />
          <span>账户余额</span>
          {updatedAt && (
            <time
              className="data-time"
              title={`最后成功更新：${updateTime(updatedAt, true)}（本机时区）`}
            >
              {updateTime(updatedAt)}
            </time>
          )}
          <PricingPeriodBadge />
        </div>
        {error && state === "ok" ? (
          <button
            className="status-pill off"
            onClick={onDataStatus}
            title="保留上次数据，查看更新失败原因"
          >
            更新失败 ›
          </button>
        ) : (
          <div className={`status-pill ${statusOff ? "off" : ""}`}>
            <span />
            {statusText}
          </div>
        )}
      </div>
      {/* key 取展示值：值变化时重挂载，驱动 value-in 动画；值不变则不重播 */}
      <div
        key={amount}
        title={
          state === "ok"
            ? `${symbol}${balance?.totalBalance ?? "0.00"}`
            : undefined
        }
        className={`balance-amount ${state !== "ok" ? "balance-dim" : ""}`}
      >
        {amount}
      </div>
      {state === "error" && (
        <button className="data-status-link" onClick={onDataStatus}>
          查看失败原因 ›
        </button>
      )}
      {state === "nokey" && (
        <button className="data-status-link" onClick={onSettings}>
          配置 API Key ›
        </button>
      )}
      <div className="metric-grid">
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <SunMedium size={15} />
            <span>当日消耗</span>
          </div>
          {/* 用量费用恒为人民币计价，不能跟余额币种（可能是 USD）走 */}
          <strong
            key={todayCost ?? "na"}
            title={todayCost != null ? fmtMoney(todayCost) : undefined}
          >
            {todayCost != null ? fmtMoneyDisplay(todayCost, "¥") : "—"}
          </strong>
        </div>
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <CalendarDays size={15} />
            <span>本月消费</span>
          </div>
          <strong
            key={monthCost ?? "na"}
            title={monthCost != null ? fmtMoney(monthCost) : undefined}
          >
            {monthCost != null ? fmtMoneyDisplay(monthCost, "¥") : "—"}
          </strong>
        </div>
      </div>
    </article>
  );
}
export { BalanceCard };
