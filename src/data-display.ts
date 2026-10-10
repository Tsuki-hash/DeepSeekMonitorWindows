export function updateTime(
  timestamp: number | null | undefined,
  full = false,
  timeZone?: string,
): string {
  if (!timestamp) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(timeZone ? { timeZone } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(full ? { month: "2-digit", day: "2-digit", second: "2-digit" } : {}),
  }).format(timestamp);
}

export function snapshotAge(
  timestamp: number | null | undefined,
  now = Date.now(),
): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "尚未取得";
  if (!Number.isFinite(now) || timestamp > now) return "时间待核对";
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1440)}天前`;
}

export function snapshotHealth(
  state: "loading" | "ok" | "error" | "nokey",
  hasSnapshot: boolean,
  error = "",
  code?: string,
  needsCheck = false,
): string {
  if (state === "nokey") return "未配置";
  if (state === "loading") return "更新中";
  if (code === "credentials_invalid" && error) return "凭据失效";
  if (error || state === "error")
    return hasSnapshot ? "旧数据 · 更新失败" : "更新失败 · 尚未取得";
  if (!hasSnapshot) return "尚未取得";
  return needsCheck ? "已返回 · 待核对" : "已返回";
}
