// 刷新与托盘发布的纯策略。
//
// 评审 P2 的两处修复原先直接写在 App.tsx 的 effect 里，无法单独测试：
// 1. 余额与用量必须各自调度 —— 一路未配置不能把另一路拖慢到 1 小时；
// 2. 托盘只发布「当前凭据仍有效」的金额 —— 失效凭据的旧值不能回闪。
//
// 这里把判定收敛成纯函数，App 只负责调用。

export type ChannelOutcome = {
  /** 该通道是否暂停（未配置 / 凭据失效）：暂停时既不联网也不累加退避。 */
  paused: boolean;
  /** 累计的可重试失败次数。 */
  failures: number;
  /** 下一次尝试的间隔（秒）。 */
  delaySeconds: number;
};

const RETRYABLE = new Set(["rate_limited", "unavailable", "unknown"]);
const PAUSED = new Set(["not_configured", "credentials_invalid"]);
const MAX_DELAY_SECONDS = 3600;

/** 单通道在收到一次失败后的调度决策。 */
export function channelDecision(input: {
  code?: string;
  failures: number;
  baseSeconds: number;
}): ChannelOutcome {
  const { code, failures, baseSeconds } = input;
  if (code && PAUSED.has(code)) {
    return {
      paused: true,
      failures: 0,
      delaySeconds: Math.min(300, baseSeconds),
    };
  }
  if (!code || !RETRYABLE.has(code)) {
    // 非可重试错误（如数据异常）：不累加退避，保持用户所选周期。
    return { paused: false, failures: 0, delaySeconds: baseSeconds };
  }
  const next = failures + 1;
  const delaySeconds = Math.min(
    MAX_DELAY_SECONDS,
    baseSeconds * 2 ** Math.min(6, next),
  );
  return { paused: false, failures: next, delaySeconds };
}

/** 托盘发布判定：只有「凭据仍有效且持有快照」才发布金额。 */
export function balancePublishable(input: {
  credentialValid: boolean;
  balance: { totalBalance: string; currency: string } | null;
  /** 当前请求是否仍在进行或上次失败：此时要标旧。 */
  stale?: boolean;
}): { totalBalance: string; currency: string; stale: boolean } | null {
  if (!input.credentialValid || !input.balance) return null;
  return {
    totalBalance: input.balance.totalBalance,
    currency: input.balance.currency,
    // 默认标旧：调用方传入 stale 才可能为 false，避免旧值被当成当前值。
    stale: input.stale !== false,
  };
}
