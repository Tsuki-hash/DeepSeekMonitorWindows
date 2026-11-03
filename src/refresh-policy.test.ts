import { test } from "node:test";
import assert from "node:assert/strict";
import { channelDecision, balancePublishable } from "./refresh-policy.ts";

test("未配置与凭据失效暂停通道_不参与退避也不拖慢其他通道", () => {
  assert.equal(
    channelDecision({ code: "not_configured", failures: 0, baseSeconds: 60 })
      .paused,
    true,
  );
  assert.equal(
    channelDecision({
      code: "credentials_invalid",
      failures: 0,
      baseSeconds: 60,
    }).paused,
    true,
  );
  // 暂停通道不再累加失败次数，恢复后不会带着旧退避。
  assert.equal(
    channelDecision({ code: "not_configured", failures: 5, baseSeconds: 60 })
      .failures,
    0,
  );
});

test("可重试错误按指数退避_上限一小时", () => {
  const once = channelDecision({
    code: "unavailable",
    failures: 0,
    baseSeconds: 60,
  });
  assert.equal(once.failures, 1);
  assert.equal(once.delaySeconds, 120);
  const many = channelDecision({
    code: "unavailable",
    failures: 20,
    baseSeconds: 60,
  });
  assert.equal(many.delaySeconds, 3600);
  const quick = channelDecision({
    code: "unavailable",
    failures: 0,
    baseSeconds: 1,
  });
  assert.equal(quick.delaySeconds, 2);
});

test("非可重试错误不累加退避_健康刷新保持用户所选周期", () => {
  const decision = channelDecision({
    code: "invalid_data",
    failures: 3,
    baseSeconds: 60,
  });
  assert.equal(decision.failures, 0);
  assert.equal(decision.delaySeconds, 60);
  assert.equal(decision.paused, false);
});

test("托盘只在凭据仍有效时发布金额_失效后不重新出现", () => {
  const cases: [boolean, boolean, string | null][] = [
    [true, true, "19.62"],
    [true, false, null],
    [false, true, null],
    [false, false, null],
  ];
  for (const [credentialValid, hasBalance, expected] of cases) {
    const result = balancePublishable({
      credentialValid,
      balance: hasBalance ? { totalBalance: "19.62", currency: "CNY" } : null,
    });
    assert.equal(result?.totalBalance ?? null, expected);
  }
});

test("普通断网保留快照但标旧_凭据失效则不发布", () => {
  const offline = balancePublishable({
    credentialValid: true,
    balance: { totalBalance: "19.62", currency: "CNY" },
  });
  assert.ok(offline);
  assert.equal(offline.stale, true, "请求中/上次失败时快照要标旧");
});
