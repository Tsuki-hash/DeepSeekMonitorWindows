// 已提交配置的跨挂载共享（第六轮复评 R10）。
//
// 设置页卸载后重新进入时，新的 useSettingsState 若只读挂载瞬间的后端配置，
// 会停留在保存前的快照：延迟成功的 API Key 保存只更新了旧实例的内部状态。
// 这里锁定共享 store 的契约：提交后通知所有订阅者、后来挂载的实例能立即
// 读到已提交配置、取消订阅后不再收到通知。不写 localStorage，凭据不进草稿。
//
// 运行方式：`npm test` → `node --test --experimental-strip-types src/`。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyReadConfig,
  getCommitRevision,
  getCommittedConfig,
  setCommittedConfig,
  subscribeCommittedConfig,
} from "./config-store.ts";
import type { AppConfig } from "./types";

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  apiKeyConfigured: false,
  apiKeyPreview: null,
  usageTokenConfigured: false,
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: false,
  autostart: false,
  configPath: "%APPDATA%\\DeepSeekMonitorWindows\\config.json",
  ...over,
});

test("R10：提交后所有已挂载实例收到同一份配置", () => {
  setCommittedConfig(config());
  let first = 0;
  let second = 0;
  const offFirst = subscribeCommittedConfig(() => (first += 1));
  const offSecond = subscribeCommittedConfig(() => (second += 1));
  setCommittedConfig(config({ apiKeyConfigured: true }));
  assert.equal(first, 1, "旧实例被通知");
  assert.equal(second, 1, "另一个已挂载实例同样被通知");
  assert.equal(getCommittedConfig()?.apiKeyConfigured, true);
  offFirst();
  offSecond();
  setCommittedConfig(null);
});

test("R10：重新挂载的设置页能直接读到已提交配置", () => {
  setCommittedConfig(
    config({ apiKeyConfigured: true, apiKeyPreview: "sk-…abc" }),
  );
  // 新实例初始化：useState(getCommittedConfig) 直接拿到已提交值，
  // 不必等自己的 get_app_config 返回。
  const initial = getCommittedConfig();
  assert.equal(initial?.apiKeyConfigured, true);
  assert.equal(initial?.apiKeyPreview, "sk-…abc");
  setCommittedConfig(null);
});

test("R10：取消订阅后不再收到通知_取消可重复", () => {
  setCommittedConfig(config());
  let calls = 0;
  const off = subscribeCommittedConfig(() => (calls += 1));
  off();
  off();
  setCommittedConfig(config({ usageTokenConfigured: true }));
  assert.equal(calls, 0);
  setCommittedConfig(null);
});

// ---------- 第七轮复评 F08：旧读取不得回滚新提交 ----------

test("F08：读取发起后有新提交_旧读取结果被丢弃", () => {
  setCommittedConfig(config());
  // 旧 GET 发起：捕获当时的提交代际。
  const startedAt = getCommitRevision();
  // 用户在此期间保存了凭据（提交递增）。
  setCommittedConfig(config({ apiKeyConfigured: true }));
  // 旧 GET 这时才返回「未配置」——必须被拒绝。
  const accepted = applyReadConfig(config(), startedAt);
  assert.equal(accepted, false, "旧读取不得覆盖新提交");
  assert.equal(
    getCommittedConfig()?.apiKeyConfigured,
    true,
    "已保存的凭据状态必须保留",
  );
  setCommittedConfig(null);
});

test("F08：读取发起后无新提交_读取结果正常接受", () => {
  setCommittedConfig(null);
  const startedAt = getCommitRevision();
  const accepted = applyReadConfig(
    config({ usageTokenConfigured: true }),
    startedAt,
  );
  assert.equal(accepted, true);
  assert.equal(getCommittedConfig()?.usageTokenConfigured, true);
  setCommittedConfig(null);
});

test("F08：两个写入交错_提交后发起的读取仍然有效", () => {
  setCommittedConfig(config());
  const beforeCommit = getCommitRevision();
  setCommittedConfig(config({ apiKeyConfigured: true }));
  const afterCommit = getCommitRevision();
  // 提交**之前**发起的读取被丢弃（会回滚新提交）。
  assert.equal(applyReadConfig(config(), beforeCommit), false);
  // 提交**之后**发起的读取是新鲜的，允许接受（它反映更晚的后端状态）。
  assert.equal(
    applyReadConfig(
      config({ apiKeyConfigured: true, usageTokenConfigured: true }),
      afterCommit,
    ),
    true,
  );
  assert.equal(getCommittedConfig()?.usageTokenConfigured, true);
  setCommittedConfig(null);
});
