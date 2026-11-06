// 历史查询的错误分类。
//
// 评审 P1：原实现把所有异常都 `catch { failed.push(month) }` 吞掉，最后只显示
// 「N 个月份未取得」。未配置、失效凭据与限流没有不同的恢复路径 —— 未配置时反复
// 产生无用 IPC，凭据过期时逐月重复无效请求。
//
// 这里把「该停止还是该继续」收敛成纯函数，组件只负责执行。

export type HistoryFailureKind =
  /** 本地配置不可信：先恢复读取，不能误导用户重新登录。 */
  | "config"
  /** 未配置或凭据失效：后续月份一定也会失败，必须立即停止。 */
  | "auth"
  /** 限流/服务端暂时不可用：停止连打，等待用户重试。 */
  | "transient"
  /** 仅该月份失败（如数据异常）：继续查询其余月份。 */
  | "month";

export type HistoryFailure = {
  kind: HistoryFailureKind;
  month: string;
  message: string;
};

/** 已知 IPC code 优先判定；未分类及旧错误仍保留鉴权文案兼容兜底。 */
export function classifyHistoryFailure(
  error: unknown,
  month: string,
): HistoryFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : typeof error === "string"
        ? error
        : "";
  const kind: HistoryFailureKind =
    code === "config_read_error"
      ? "config"
      : code === "not_configured" || code === "credentials_invalid"
        ? "auth"
        : code === "rate_limited" || code === "unavailable"
          ? "transient"
          : code === "invalid_data"
            ? // 已确认的数据错误不因提到 Token 统计或登录字段而变成鉴权失败。
              "month"
            : // unknown 是未分类，也可能来自旧鉴权错误；保留兼容文本兜底，
              // 不能仅因为带有 code 字段就逐月重试可能已失效的凭据。
              /未配置|Token|凭据|登录/.test(message)
              ? "auth"
              : "month";
  return { kind, month, message };
}

export type HistoryFailureOutcome = {
  /** 是否继续查询剩余月份。 */
  continue: boolean;
  /** 给用户的下一步动作。 */
  recovery: "config" | "configure" | "relogin" | "retry" | "partial";
  text: string;
};

export function historyFailureOutcome(
  failure: HistoryFailure,
  failedMonths: string[],
  credentialConfigured = true,
): HistoryFailureOutcome {
  if (failure.kind === "config") {
    return {
      continue: false,
      recovery: "config",
      text: "本地配置读取失败，历史查询已暂停，原文件未改动。请检查文件读取权限或本机加密服务；配置损坏时安全修复或移走 config.json，再重新读取配置。",
    };
  }
  if (failure.kind === "auth") {
    return credentialConfigured
      ? {
          continue: false,
          recovery: "relogin",
          text: `用量 Token 已失效，查询在 ${failure.month} 停止；请重新同步后再查询。`,
        }
      : {
          continue: false,
          recovery: "configure",
          text: "尚未配置用量 Token，查询已停止；请先在设置页配置。",
        };
  }
  if (failure.kind === "transient") {
    return {
      continue: false,
      recovery: "retry",
      text: `用量接口暂时不可用（${failure.month}），已停止查询以免连续请求；可稍后重试。`,
    };
  }
  return {
    continue: true,
    recovery: "partial",
    text: `${failedMonths.length} 个月份未取得（${failure.month} 等），未返回日期标为未知。`,
  };
}

/** 只重试失败月份，不重跑整段历史。 */
export function failedMonthsOnly(failed: string[], all: string[]): string[] {
  const failedSet = new Set(failed);
  return all.filter((month) => failedSet.has(month));
}
