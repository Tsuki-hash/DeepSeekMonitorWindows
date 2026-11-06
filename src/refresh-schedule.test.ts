import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptySchedule,
  dueAtFrom,
  isDue,
  msUntilDue,
  reschedule,
} from "./refresh-schedule.ts";

test("排期使用绝对截止时间_延迟为负按立即处理", () => {
  assert.equal(dueAtFrom(1000, 60), 61_000);
  assert.equal(dueAtFrom(1000, -5), 1000);
  assert.equal(dueAtFrom(1000, Number.NaN), 1000);
});

test("到期判定与剩余时间", () => {
  const schedule = reschedule(emptySchedule(), 0, 120);
  assert.equal(schedule.dueAt, 120_000);
  assert.equal(isDue(schedule, 60_000), false);
  assert.equal(isDue(schedule, 120_000), true);
  assert.equal(msUntilDue(schedule, 60_000), 60_000);
  assert.equal(msUntilDue(schedule, 200_000), 0);
});

test("未排期的通道不算到期", () => {
  const schedule = emptySchedule();
  assert.equal(isDue(schedule, 1_000_000), false);
  assert.equal(msUntilDue(schedule, 1_000_000), 0);
});

test("重排只影响传入的通道_另一通道截止时间不变", () => {
  // 复评 R01 的核心不变量：余额完成不得推迟用量的退避截止时间。
  const usage = reschedule(emptySchedule(), 0, 120);
  const balance = reschedule(emptySchedule(), 0, 60);
  // 余额在 60s 完成并重新排期 60s —— 用量仍是原来的 120s 截止时间。
  const balanceAfter = reschedule({ ...balance, running: false }, 60_000, 60);
  assert.equal(balanceAfter.dueAt, 120_000);
  // 关键：用量对象未被余额的重排修改。
  assert.equal(usage.dueAt, 120_000, "用量截止时间不受余额影响");
  assert.equal(isDue(usage, 120_000), true);
  assert.equal(isDue(usage, 119_000), false);
});

test("重排保留在途标记", () => {
  const running = { ...emptySchedule(), running: true };
  assert.equal(reschedule(running, 0, 60).running, true);
});
