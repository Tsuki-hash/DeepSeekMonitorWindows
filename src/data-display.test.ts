import { test } from "node:test";
import assert from "node:assert/strict";
import { updateTime, snapshotAge, snapshotHealth } from "./data-display.ts";

test("更新时间默认使用电脑本地时区", () => {
  const timestamp = Date.parse("2026-09-30T16:05:06Z");
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(
    updateTime(timestamp),
    updateTime(timestamp, false, localTimeZone),
  );
  assert.equal(
    updateTime(timestamp, true),
    updateTime(timestamp, true, localTimeZone),
  );
});

test("跨日更新时间随时区变化，平台记账日期不受影响", () => {
  const timestamp = Date.parse("2026-09-30T16:05:06Z");
  assert.equal(updateTime(timestamp, true, "Asia/Shanghai"), "10/01 00:05:06");
  assert.equal(
    updateTime(timestamp, true, "America/New_York"),
    "09/30 12:05:06",
  );
});

test("未取得成功快照时不伪造更新时间", () => {
  assert.equal(updateTime(null), "尚未更新");
  assert.equal(updateTime(undefined), "尚未更新");
});

test("快照年龄区分未知、未来、分钟小时天", () => {
  assert.equal(snapshotAge(null, 1000), "尚未取得");
  assert.equal(snapshotAge(2000, 1000), "时间待核对");
  assert.equal(snapshotAge(0, 1000), "刚刚");
  assert.equal(snapshotAge(0, 300000), "5分钟前");
  assert.equal(snapshotAge(0, 7200000), "2小时前");
  assert.equal(snapshotAge(0, 172800000), "2天前");
});

test("来源状态区分旧数据、凭据失效与未知", () => {
  assert.equal(snapshotHealth("ok", true, "offline"), "旧数据 · 更新失败");
  assert.equal(
    snapshotHealth("error", false, "expired", "credentials_invalid"),
    "凭据失效",
  );
  assert.equal(
    snapshotHealth("error", false, "offline"),
    "更新失败 · 尚未取得",
  );
  assert.equal(
    snapshotHealth("ok", true, "", undefined, true),
    "已返回 · 待核对",
  );
  assert.equal(snapshotHealth("nokey", false), "未配置");
});
