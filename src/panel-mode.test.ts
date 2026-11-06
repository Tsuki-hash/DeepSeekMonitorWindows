import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestedMode } from "./panel-mode.ts";

test("只有历史建议展开_账户与设置保持紧凑", () => {
  assert.equal(suggestedMode("history"), "expanded");
  assert.equal(suggestedMode("dashboard"), "compact");
  assert.equal(suggestedMode("settings"), "compact");
  assert.equal(suggestedMode("detail"), "compact");
});

test("未知视图保持紧凑_不会意外放大窗口", () => {
  assert.equal(suggestedMode("unknown-view"), "compact");
  assert.equal(suggestedMode(""), "compact");
});
