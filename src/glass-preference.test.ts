import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alphaFromTransparency,
  transparencyFromAlpha,
  resolveTransparency,
  DEFAULT_GLASS,
} from "./glass-preference.ts";

test("透明度与 CSS alpha 互为逆运算", () => {
  for (const value of [0, 5, 35, 70]) {
    assert.equal(
      transparencyFromAlpha(String(alphaFromTransparency(value))),
      value,
    );
  }
});

test("存储被清空时沿用当前生效值_自定义外观不丢", () => {
  // 用户设了 35%，随后清登录数据把 localStorage 清空。
  assert.equal(resolveTransparency(null, 35), 35);
  // 有存储值时以存储为准。
  assert.equal(resolveTransparency("35", 5), 35);
  // 两者都没有才回落默认值。
  assert.equal(resolveTransparency(null, null), DEFAULT_GLASS);
});

test("非法存储值不会让外观跳到意外位置", () => {
  assert.equal(resolveTransparency("abc", 35), 35);
  assert.equal(resolveTransparency("-5", 35), 0);
  assert.equal(resolveTransparency("200", 35), 70);
});

test("非法 alpha 不被当成 0", () => {
  assert.equal(transparencyFromAlpha(""), null);
  assert.equal(transparencyFromAlpha("NaN"), null);
  assert.equal(transparencyFromAlpha("1.5"), null);
  assert.equal(transparencyFromAlpha("1"), 0);
});
