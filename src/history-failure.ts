// 历史查询的错误分类。
//
// 评审 P1：原实现把所有异常都 `catch { failed.push(month) }` 吞掉，最后只显示
// 「N 个月份未取得」。未配置、失效凭据与限流没有不同的恢复路径 —— 未配置时反复
// 产生无用 IPC，凭据过期时逐月重复无效请求。
//
// 这里把「该停止还是该继续」收敛成纯函数，组件只负责执行。

export type HistoryFailureKind =
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

/** 从 IPC 错误的稳定 code 判定类别；文案不参与判定。 */
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
    code === "not_configured" || code === "credentials_invalid"
      ? "auth"
      : code === "rate_limited" || code === "unavailable"
        ? "transient"
        : // 没有 code 的老式错误按文案兜底，但只用于决定「是否继续」。
          /未配置|Token|凭据|登录/.test(message)
          ? "auth"
          : "month";
  return { kind, month, message };
}

export type HistoryFailureOutcome = {
  /** 是否继续查询剩余月份。 */
  continue: boolean;
  /** 给用户的下一步动作。 */
  recovery: "configure" | "relogin" | "retry" | "partial";
  text: string;
};

export function historyFailureOutcome(
  failure: HistoryFailure,
  failedMonths: string[],
  credentialConfigured = true,
): HistoryFailureOutcome {
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
