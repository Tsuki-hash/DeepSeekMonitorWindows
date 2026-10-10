import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalRateTracker,
  localAverageRate,
  localProjects,
  localSessions,
  localSum,
} from "./local-usage.ts";
import type { LocalRow } from "./local-usage.ts";
function row(id = "r1"): LocalRow {
  return {
    id,
    tool: "opencode",
    sessionId: "same",
    projectKey: "d:/repo",
    projectPath: "D:\\Repo",
    model: "deepseek",
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0,
    reasoning: 10,
    totalTokens: 170,
    messageCount: 1,
    timedOutputTokens: 20,
    timedDurationMs: 1000,
    firstActiveMs: null,
    lastActiveMs: 1,
  };
}
test("聚合超过安全整数或非法计数保持未知，速度不除以无效汇总", () => {
  const huge = {
    ...row(),
    totalTokens: Number.MAX_SAFE_INTEGER,
    timedOutputTokens: Number.MAX_SAFE_INTEGER,
    timedDurationMs: 1001,
  };
  assert.equal(localSum([huge, huge], "totalTokens"), null);
  assert.equal(localAverageRate([huge, huge]), null);
  assert.equal(localSum([{ ...row(), totalTokens: -1 }], "totalTokens"), null);
  assert.equal(localSum([{ ...row(), totalTokens: 1.2 }], "totalTokens"), null);
  const tracker = new LocalRateTracker();
  tracker.observe([row("a"), row("b")], 1000);
  tracker.observe(
    [
      { ...huge, id: "a" },
      { ...huge, id: "b" },
    ],
    2000,
  );
  assert.equal(tracker.reading(2000), null);
});
test("同路径项目合并、同ID不同工具会话隔离、未归属不猜测", () => {
  const rows = [
    row(),
    { ...row("r2"), tool: "claude" },
    { ...row("r3"), projectKey: null, projectPath: null, sessionId: "new" },
  ];
  assert.equal(localProjects(rows).length, 2);
  assert.equal(localProjects(rows)[0].rows.length, 2);
  assert.equal(localSessions(rows).length, 3);
  assert.equal(localSum([{ ...row(), input: null }], "input"), null);
});
test("同名会话与未归属项目按采集来源隔离，旧快照默认为本机", () => {
  const native = row();
  const extra = {
    ...row("source-extra"),
    sourceId: "home-extra",
    sourceLabel: "目录1",
  };
  assert.equal(localSessions([native, extra]).length, 2);
  assert.equal(
    localProjects([
      { ...native, projectKey: null, projectPath: null },
      { ...extra, projectKey: null, projectPath: null },
    ]).length,
    2,
  );
  assert.equal(
    localSessions([native, { ...row("same-native"), sourceId: "native" }])
      .length,
    1,
  );
});
test("平均速度按匹配耗时加权，缺耗时不混入分母", () => {
  assert.equal(
    localAverageRate([
      row(),
      {
        ...row("r2"),
        output: 5000,
        timedOutputTokens: null,
        timedDurationMs: null,
      },
    ]),
    20,
  );
  assert.equal(localAverageRate([{ ...row(), timedDurationMs: null }]), null);
});
test("实时样本只用性能增量，不受扫描间隔影响且首次历史不伪装实时", () => {
  const tracker = new LocalRateTracker();
  tracker.observe([row()], 1000);
  assert.equal(tracker.reading(1000), null);
  tracker.observe(
    [{ ...row(), timedOutputTokens: 60, timedDurationMs: 3000 }],
    100000,
  );
  assert.equal(tracker.reading(100000)?.rate, 20);
  tracker.observe(
    [{ ...row(), timedOutputTokens: 60, timedDurationMs: 3000 }],
    100010,
  );
  assert.equal(tracker.reading(108000)?.fresh, false);
  assert.equal(tracker.reading(280000), null);
});
test("计数回退、来源消失及重置清速度；新发现行不当成新增生成", () => {
  const tracker = new LocalRateTracker();
  tracker.observe([row()], 1);
  tracker.observe(
    [{ ...row(), timedOutputTokens: 40, timedDurationMs: 2000 }],
    2,
  );
  tracker.observe([row()], 3);
  assert.equal(tracker.reading(3), null);
  tracker.observe([row(), row("new")], 4);
  assert.equal(tracker.reading(4), null);
  tracker.reset();
  assert.equal(tracker.reading(5), null);
});
