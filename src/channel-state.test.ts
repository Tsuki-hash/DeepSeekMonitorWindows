import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChannelState,
  onChannelSuccess,
  onChannelFailure,
  onCredentialChanged,
  scheduledDelaySeconds,
} from "./channel-state.ts";

const base = 60;

test("成功清暂停与失败数_恢复基础间隔与快照", () => {
  const failed = onChannelFailure(
    initialChannelState(base),
    "unavailable",
    base,
  );
  assert.equal(failed.failures, 1);
  const recovered = onChannelSuccess(failed, base);
  assert.equal(recovered.paused, false);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.nextDelaySeconds, base);
  assert.equal(recovered.hasSnapshot, true);
});

test("未配置与凭据失效进入暂停_并作废快照", () => {
  for (const code of ["not_configured", "credentials_invalid"]) {
    const state = onChannelFailure(
      { ...initialChannelState(base), hasSnapshot: true },
      code,
      base,
    );
    assert.equal(state.paused, true, code);
    assert.equal(state.failures, 0, code);
    assert.equal(state.hasSnapshot, false, code);
    // 暂停通道仍要有探测间隔，不能变成 0 造成空转。
    assert.ok(scheduledDelaySeconds(state) > 0);
  }
});

test("可重试错误指数退避_封顶一小时", () => {
  let state = initialChannelState(base);
  const delays: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    state = onChannelFailure(state, "unavailable", base);
    delays.push(state.nextDelaySeconds);
  }
  assert.deepEqual(delays.slice(0, 3), [120, 240, 480]);
  assert.equal(delays.at(-1), 3600);
  // 失败计数继续增长，但延迟不再增加。
  assert.ok(state.failures > 6);
});

test("不可重试错误不累加退避_保持用户所选周期", () => {
  const state = onChannelFailure(
    { ...initialChannelState(base), failures: 4 },
    "invalid_data",
    base,
  );
  assert.equal(state.failures, 0);
  assert.equal(state.paused, false);
  assert.equal(state.nextDelaySeconds, base);
});

test("凭据保存成功解除暂停且可立即刷新_清除则暂停", () => {
  const paused = onChannelFailure(
    initialChannelState(base),
    "not_configured",
    base,
  );
  const saved = onCredentialChanged(paused, true, base);
  assert.equal(saved.paused, false);
  assert.equal(
    saved.nextDelaySeconds,
    0,
    "验证成功后应立即请求，而不是等一个周期",
  );
  assert.equal(saved.failures, 0);

  const cleared = onCredentialChanged(saved, false, base);
  assert.equal(cleared.paused, true);
  assert.equal(cleared.hasSnapshot, false);
});

test("两个通道互不影响_一个暂停另一个照常退避", () => {
  const balance = onChannelFailure(
    initialChannelState(base),
    "not_configured",
    base,
  );
  const usage = onChannelFailure(
    initialChannelState(base),
    "rate_limited",
    base,
  );
  assert.equal(balance.paused, true);
  assert.equal(usage.paused, false);
  assert.equal(usage.nextDelaySeconds, 120);
  assert.equal(scheduledDelaySeconds(balance), 300);
  assert.equal(scheduledDelaySeconds(usage), 120);
});
