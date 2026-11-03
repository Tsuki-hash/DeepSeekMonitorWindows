import { test } from "node:test";
import assert from "node:assert/strict";
import { msUntilNextAccountingDate } from "./accounting-clock.ts";

const HOUR = 3600_000;

test("东八区正午到次日 00:00 正好 12 小时", () => {
  // 2026-09-30T04:00:00Z = 北京时间 12:00
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-09-30T04:00:00Z")),
    12 * HOUR,
  );
});

test("跨月边界与普通日期同一规则_不受电脑时区影响", () => {
  // 2026-09-30T15:59:59Z = 北京时间 23:59:59 → 距下一天 1 秒
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-09-30T15:59:59Z")),
    1000,
  );
  // 跨月那一秒之后就是新的记账日
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-09-30T16:00:00Z")),
    24 * HOUR,
  );
  // 跨年同理
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-12-31T15:59:00Z")),
    60_000,
  );
});

test("恰好落在记账日零点返回整天_避免调度器空转", () => {
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-09-30T16:00:00Z")),
    24 * HOUR,
  );
  assert.equal(
    msUntilNextAccountingDate(new Date("2026-09-30T15:59:59.999Z")),
    1,
  );
});

test("返回值恒在 0 到 24 小时内_非法时间不返回负数", () => {
  const invalid = new Date(Number.NaN);
  assert.equal(msUntilNextAccountingDate(invalid), 24 * HOUR);
  for (let minutes = 0; minutes < 24 * 60; minutes += 7) {
    const at = new Date(Date.UTC(2026, 8, 30, 0, minutes, 0));
    const value = msUntilNextAccountingDate(at);
    assert.ok(
      value > 0 && value <= 24 * HOUR,
      `${at.toISOString()} → ${value}`,
    );
  }
});
