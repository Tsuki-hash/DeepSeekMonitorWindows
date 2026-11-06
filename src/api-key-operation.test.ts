import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
} from "./api-key-operation.ts";

test("Key操作跨设置页面生命周期：清除或新保存拒绝旧响应", () => {
  const saving = beginApiKeyOperation();
  const clearing = beginApiKeyOperation();
  assert.equal(isCurrentApiKeyOperation(saving), false);
  assert.equal(isCurrentApiKeyOperation(clearing), true);
  const newerSave = beginApiKeyOperation();
  assert.equal(isCurrentApiKeyOperation(clearing), false);
  assert.equal(isCurrentApiKeyOperation(newerSave), true);
});

import {
  beginUsageTokenOperation,
  isCurrentUsageTokenOperation,
} from "./api-key-operation.ts";
test("N05: Token operation ownership spans page remounts and stays independent of Key", () => {
  const token = beginUsageTokenOperation();
  const key = beginApiKeyOperation();
  assert.equal(isCurrentUsageTokenOperation(token), true);
  const newerToken = beginUsageTokenOperation();
  assert.equal(isCurrentUsageTokenOperation(token), false);
  assert.equal(isCurrentUsageTokenOperation(newerToken), true);
  assert.equal(isCurrentApiKeyOperation(key), true);
});
