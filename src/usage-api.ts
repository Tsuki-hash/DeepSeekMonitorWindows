import { invoke } from "@tauri-apps/api/core";
import { todayStr } from "./format";
import type { UsageResult } from "./types";
import { RequestGate } from "./request-gate";
import { historyCache } from "./history-cache";

const usageGate = new RequestGate<UsageResult>();
export const invalidateUsageRequests = () => {
  usageGate.invalidate();
  historyCache.invalidate();
};

export const fetchMonthUsage = (month: number, year: number) => {
  return invoke<UsageResult>("fetch_usage", { month, year });
};
export const fetchCurrentUsage = () =>
  usageGate.run(async () => {
    const date = todayStr();
    const [year, month, day] = date.split("-").map(Number);
    const current = {
      ...(await fetchMonthUsage(month, year)),
      accountingDate: date,
    };
    const needsPreviousMonth = day <= 6;
    if (!needsPreviousMonth) {
      return current;
    }
    try {
      const previous =
        month === 1
          ? { month: 12, year: year - 1 }
          : { month: month - 1, year };
      const previousUsage = await fetchMonthUsage(
        previous.month,
        previous.year,
      );
      return {
        ...current,
        days: [...previousUsage.days, ...current.days],
      };
    } catch {
      const now = new Date(`${date}T00:00:00Z`);
      const unavailableDates = Array.from({ length: 7 }, (_, i) =>
        new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10),
      ).filter((d) => d.slice(0, 7) !== date.slice(0, 7));
      return {
        ...current,
        unavailableDates,
        warnings: [
          ...(current.warnings ?? []),
          "上月数据暂未获取，缺失日期标为未知",
        ],
      };
    }
  });

export const refreshOptions = [
  { label: "1 分钟", value: 60 },
  { label: "5 分钟", value: 300 },
  { label: "30 分钟", value: 1800 },
  { label: "1 小时", value: 3600 },
];
