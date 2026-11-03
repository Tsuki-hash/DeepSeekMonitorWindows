import { test } from "node:test";
import assert from "node:assert/strict";
import {
  onboardingTasks,
  shouldShowOnboarding,
  recommendedTask,
} from "./onboarding.ts";

const empty = {
  apiKeyConfigured: false,
  usageTokenConfigured: false,
  localEnabled: false,
  dismissed: false,
};

test("三项任务覆盖三种数据来源_各自有最小条件", () => {
  const tasks = onboardingTasks(empty);
  assert.equal(tasks.length, 3);
  assert.deepEqual(
    tasks.map((task) => task.task),
    ["balance", "platform", "local"],
  );
  assert.equal(tasks[0].requirement, "配置 API Key");
  assert.equal(tasks[1].requirement, "同步用量 Token");
  assert.equal(tasks[2].requirement, "开启本地统计");
  // 只有平台用量是敏感网页登录会话。
  assert.deepEqual(
    tasks.filter((task) => task.sensitive).map((task) => task.task),
    ["platform"],
  );
});

test("只配 Key 即算完成余额任务_未配 Token 不算整体失败", () => {
  const tasks = onboardingTasks({ ...empty, apiKeyConfigured: true });
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[1].done, false);
  assert.equal(tasks[2].done, false);
});

test("任一任务完成或已关闭后不再展示入口卡", () => {
  assert.equal(shouldShowOnboarding(empty), true);
  assert.equal(
    shouldShowOnboarding({ ...empty, apiKeyConfigured: true }),
    false,
  );
  assert.equal(shouldShowOnboarding({ ...empty, localEnabled: true }), false);
  assert.equal(shouldShowOnboarding({ ...empty, dismissed: true }), false);
});

test("推荐任务取第一个未完成的_余额优先", () => {
  const tasks = onboardingTasks(empty);
  assert.equal(recommendedTask(tasks).task, "balance");
  const afterBalance = onboardingTasks({ ...empty, apiKeyConfigured: true });
  assert.equal(recommendedTask(afterBalance).task, "platform");
});
