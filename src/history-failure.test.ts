import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHistoryFailure,
  historyFailureOutcome,
  failedMonthsOnly,
} from "./history-failure.ts";

const coded = (code: string, message = "失败") => ({ code, message });

test("凭据类错误必须终止_未配置与失效给出不同恢复入口", () => {
  const missing = classifyHistoryFailure(
    coded("not_configured", "未配置用量 Token"),
    "2024-01",
  );
  assert.equal(missing.kind, "auth");
  assert.equal(
    historyFailureOutcome(missing, ["2024-01"], false).recovery,
    "configure",
  );
  const invalid = classifyHistoryFailure(
    coded("credentials_invalid", "Token 无效"),
    "2024-01",
  );
  assert.equal(invalid.kind, "auth");
  assert.equal(
    historyFailureOutcome(invalid, ["2024-01"], true).recovery,
    "relogin",
  );
  // 两种都属于「立即停止」，不能让循环继续逐月打接口。
  assert.equal(
    historyFailureOutcome(missing, ["2024-01"], false).continue,
    false,
  );
  assert.equal(
    historyFailureOutcome(invalid, ["2024-01"], true).continue,
    false,
  );
});

test("限流与服务端错误停止连打但保留重试入口", () => {
  for (const code of ["rate_limited", "unavailable"]) {
    const failure = classifyHistoryFailure(coded(code), "2024-03");
    assert.equal(failure.kind, "transient");
    const outcome = historyFailureOutcome(failure, ["2024-03"]);
    assert.equal(outcome.continue, false);
    assert.equal(outcome.recovery, "retry");
  }
});

test("单月失败继续查询其余月份_并标注部分结果", () => {
  const failure = classifyHistoryFailure(
    coded("invalid_data", "解析失败"),
    "2024-05",
  );
  assert.equal(failure.kind, "month");
  const outcome = historyFailureOutcome(failure, ["2024-05", "2024-06"]);
  assert.equal(outcome.continue, true);
  assert.equal(outcome.recovery, "partial");
  assert.ok(outcome.text.includes("2 个月份未取得"), outcome.text);
});

test("无稳定 code 的旧式错误按文案兜底判定", () => {
  assert.equal(
    classifyHistoryFailure("未配置用量 Token", "2024-01").kind,
    "auth",
  );
  assert.equal(classifyHistoryFailure("解析失败", "2024-01").kind, "month");
  assert.equal(classifyHistoryFailure(undefined, "2024-01").kind, "month");
});

test("只重试失败月份_保持原有顺序且不重复", () => {
  const all = ["2024-01", "2024-02", "2024-03", "2024-04"];
  assert.deepEqual(failedMonthsOnly(["2024-04", "2024-02"], all), [
    "2024-02",
    "2024-04",
  ]);
  assert.deepEqual(failedMonthsOnly([], all), []);
  assert.deepEqual(failedMonthsOnly(["2025-01"], all), []);
});
