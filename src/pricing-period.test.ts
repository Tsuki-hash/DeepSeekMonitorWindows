import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pricingPeriodAt,
  nextPricingTransition,
  pricingRefreshDelay,
  beijingTime,
} from "./pricing-period.ts";

const at = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);

test("峰谷按北京时间处理四个切换边界，午休为空闲", () => {
  for (const [time, expected] of [
    ["08:59:59", "offpeak"],
    ["09:00:00", "peak"],
    ["11:59:59", "peak"],
    ["12:00:00", "offpeak"],
    ["13:59:59", "offpeak"],
    ["14:00:00", "peak"],
    ["17:59:59", "peak"],
    ["18:00:00", "offpeak"],
  ] as const)
    assert.equal(pricingPeriodAt(at("2026-10-08", time)), expected);
});

test("同一时刻无论本机时区表示都使用北京时间", () => {
  const beijing = at("2026-10-08", "09:00:00");
  const newYork = Date.parse("2026-10-07T21:00:00-04:00");
  assert.equal(beijing, newYork);
  assert.equal(pricingPeriodAt(newYork), "peak");
  assert.ok(beijingTime(newYork).includes("09:00"));
});

test("周末及调休上班周末均为空闲", () => {
  for (const date of [
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
    "2026-10-11",
  ])
    assert.equal(pricingPeriodAt(at(date, "10:00:00")), "offpeak");
});

test("全年七段官方放假安排排除高峰，假期后恢复", () => {
  for (const [start, end] of [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
  ]) {
    for (
      let date = at(start, "10:00:00");
      date <= at(end, "10:00:00");
      date += 86400000
    )
      assert.equal(pricingPeriodAt(date), "offpeak");
  }
  assert.equal(pricingPeriodAt(at("2026-02-24", "10:00:00")), "peak");
  assert.equal(pricingPeriodAt(at("2026-10-08", "10:00:00")), "peak");
});

test("下一切换跳过周末和长假，午休与傍晚切换正确", () => {
  for (const [date, time, nextDate, nextTime, period] of [
    ["2026-10-08", "11:00:00", "2026-10-08", "12:00:00", "offpeak"],
    ["2026-10-08", "12:00:00", "2026-10-08", "14:00:00", "peak"],
    ["2026-10-08", "17:00:00", "2026-10-08", "18:00:00", "offpeak"],
    ["2026-10-09", "18:00:00", "2026-10-12", "09:00:00", "peak"],
    ["2026-02-13", "18:00:00", "2026-02-24", "09:00:00", "peak"],
  ] as const)
    assert.deepEqual(nextPricingTransition(at(date, time)), {
      at: at(nextDate, nextTime),
      period,
    });
});

test("未覆盖年份的潜在高峰标未知，周末及非峰窗口仍可确定谷", () => {
  assert.equal(pricingPeriodAt(at("2027-01-01", "10:00:00")), "unknown");
  assert.equal(pricingPeriodAt(at("2027-01-01", "08:00:00")), "offpeak");
  assert.equal(pricingPeriodAt(at("2027-01-02", "10:00:00")), "offpeak");
  assert.deepEqual(nextPricingTransition(at("2026-12-31", "18:00:00")), {
    at: at("2027-01-01", "09:00:00"),
    period: "unknown",
  });
});

test("刷新在边界准时调度，非边界最多30秒重新读取时钟", () => {
  assert.equal(pricingRefreshDelay(at("2026-10-08", "08:59:59")), 1000);
  assert.equal(pricingRefreshDelay(at("2026-10-08", "09:00:00")), 30000);
  assert.equal(pricingRefreshDelay(at("2026-10-08", "23:59:59")), 30000);
});

test("无效时钟安全降级", () => {
  for (const value of [NaN, Infinity, -Infinity, 1e20]) {
    assert.equal(pricingPeriodAt(value), "unknown");
    assert.equal(nextPricingTransition(value), null);
    assert.equal(pricingRefreshDelay(value), 30000);
  }
});
