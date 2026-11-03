import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftGuardText,
  shouldBlockLeave,
  draftGuardActions,
} from "./draft-guard.ts";

test("脏状态才拦截离开_干净状态直接放行", () => {
  assert.equal(shouldBlockLeave(true), true);
  assert.equal(shouldBlockLeave(false), false);
});

test("提示文案点明主体与后果_而不是笼统的确认", () => {
  const text = draftGuardText("提醒设置");
  assert.ok(text.includes("提醒设置"), text);
  assert.ok(text.includes("尚未保存"), text);
  assert.ok(text.includes("丢弃"), text);
});

test("三个动作都提供_保存与放弃都写明会离开", () => {
  assert.ok(draftGuardActions.save.includes("保存"));
  assert.ok(draftGuardActions.save.includes("离开"));
  assert.ok(draftGuardActions.discard.includes("放弃"));
  assert.ok(draftGuardActions.discard.includes("离开"));
  // 「取消」必须明确是留在当前页，不能含混成「取消操作」。
  assert.ok(draftGuardActions.cancel.includes("留在此页"));
});
