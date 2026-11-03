import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestedMode, panelModeLabel } from "./panel-mode.ts";

test("历史与 Agent 建议展开_其余保持紧凑", () => {
  assert.equal(suggestedMode("history", null), "expanded");
  assert.equal(suggestedMode("local", null), "expanded");
  assert.equal(suggestedMode("dashboard", null), "compact");
  assert.equal(suggestedMode("settings", null), "compact");
});

test("用户手动选择优先于视图建议_不会被切页覆盖", () => {
  assert.equal(suggestedMode("history", "compact"), "compact");
  assert.equal(suggestedMode("dashboard", "expanded"), "expanded");
});

test("切换标签点明动作方向", () => {
  assert.ok(panelModeLabel("compact").includes("展开"));
  assert.ok(panelModeLabel("expanded").includes("收起"));
});
