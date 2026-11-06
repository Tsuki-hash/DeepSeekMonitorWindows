// 单通道的刷新状态机。
//
// 复评 F01/F05：原实现把「成功」「失败」「设置页回调」三处各写一遍状态更新，
// 结果用量成功路径不清 paused、设置页保存成功不恢复托盘与轮询、调度又用
// 没有 code 的 channelDecision 重新计算，导致失败次数从不产生实际退避。
//
// 这里把一次「成功 / 失败 / 凭据变更」的完整状态转换收敛成纯函数，
// App 只负责把结果写进 ref/state。测试可直接驱动这些转换。

export type ChannelName = "balance" | "usage";

/** 通道运行时状态：暂停、失败计数、下次延迟都由这里派生。 */
export type ChannelState = {
  /** 通道是否暂停（未配置/凭据失效）。 */
  paused: boolean;
  /** 可重试失败的累计次数。 */
  failures: number;
  /** 下一次自动刷新的间隔（秒）。 */
  nextDelaySeconds: number;
  /** 是否有可发布的成功快照。 */
  hasSnapshot: boolean;
};

export const initialChannelState = (baseSeconds: number): ChannelState => ({
  paused: false,
  failures: 0,
  nextDelaySeconds: baseSeconds,
  hasSnapshot: false,
});

const RETRYABLE = new Set(["rate_limited", "unavailable", "unknown"]);
const PAUSED = new Set(["not_configured", "credentials_invalid"]);
const MAX_DELAY_SECONDS = 3600;
/** 暂停通道的探测间隔：凭据恢复后要能较快重新纳入调度。 */
const PAUSED_PROBE_SECONDS = 300;

/** 请求成功：清暂停、清失败、恢复快照与基础间隔。 */
export function onChannelSuccess(
  _state: ChannelState,
  baseSeconds: number,
): ChannelState {
  void _state;
  return {
    paused: false,
    failures: 0,
    nextDelaySeconds: baseSeconds,
    hasSnapshot: true,
  };
}

/**
 * 请求失败：按错误种类决定暂停或退避。
 *
 * - `not_configured` / `credentials_invalid`：暂停，失败数清零，探测间隔短。
 * - 可重试错误：失败数 +1，指数退避到上限。
 * - 其他错误（数据异常等）：不累加退避，保持基础间隔。
 */
export function onChannelFailure(
  state: ChannelState,
  code: string | undefined,
  baseSeconds: number,
): ChannelState {
  if (code && PAUSED.has(code)) {
    return {
      ...state,
      paused: true,
      failures: 0,
      // 暂停通道不再按用户周期联网：固定用探测间隔，避免每分钟打无效请求。
      nextDelaySeconds: PAUSED_PROBE_SECONDS,
      // 凭据失效时快照作废；未配置时本来就没有快照。
      hasSnapshot: false,
    };
  }
  if (!code || !RETRYABLE.has(code)) {
    return {
      ...state,
      paused: false,
      failures: 0,
      nextDelaySeconds: baseSeconds,
    };
  }
  const failures = state.failures + 1;
  return {
    ...state,
    paused: false,
    failures,
    nextDelaySeconds: Math.min(
      MAX_DELAY_SECONDS,
      baseSeconds * 2 ** Math.min(6, failures),
    ),
  };
}

/**
 * 凭据被用户显式变更（保存/清除）。
 *
 * 保存成功后应解除暂停并允许立即刷新；清除则进入暂停态。
 * `nextDelaySeconds` 归零表示「可以立刻请求」，由调用方决定何时发起。
 */
export function onCredentialChanged(
  state: ChannelState,
  configured: boolean,
  _baseSeconds: number,
): ChannelState {
  void _baseSeconds;
  if (!configured) {
    return {
      paused: true,
      failures: 0,
      nextDelaySeconds: PAUSED_PROBE_SECONDS,
      hasSnapshot: false,
    };
  }
  return {
    paused: false,
    failures: 0,
    // 刚验证成功的凭据不需要再等一个周期。
    nextDelaySeconds: 0,
    hasSnapshot: state.hasSnapshot,
  };
}

/** 调度器读取：暂停通道用短探测间隔，其余用已计算的延迟。 */
export function scheduledDelaySeconds(state: ChannelState): number {
  return state.paused
    ? Math.min(
        PAUSED_PROBE_SECONDS,
        state.nextDelaySeconds || PAUSED_PROBE_SECONDS,
      )
    : state.nextDelaySeconds;
}
