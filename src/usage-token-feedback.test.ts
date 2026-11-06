import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTokenFeedback } from "./usage-token-feedback.ts";
import { UsageSessionCleanup } from "./usage-session-cleanup.ts";

const saved = {
  usageTokenRevision: 1,
  usageTokenConfigured: true,
  configReadError: null as string | null,
};

test("R17: first trusted read and unrelated commits retain candidate feedback", () => {
  for (const message of ["Pending verification", "Synthetic Token rejection"]) {
    const feedback = new UsageTokenFeedback(null);
    const owner = feedback.begin(1, message);
    feedback.observe(saved);
    feedback.observe({ ...saved });
    assert.equal(feedback.status, message);
    assert.equal(feedback.update(owner, 1, "Current failure"), true);
  }
});

test("R17: edit and same-text ABA generations reject old clipboard and receipts", () => {
  const feedback = new UsageTokenFeedback(saved);
  const owner = feedback.begin(1, "Reading clipboard");
  feedback.edit();
  feedback.edit();
  assert.equal(feedback.ownsIntent(owner, 3), false);
  assert.equal(feedback.update(owner, 3, "Late success", true), false);
  assert.equal(feedback.status, "用量 Token 已配置");
});

test("R17: newer actions supersede earlier intents without requiring a text edit", () => {
  for (const action of ["Paste", "Save", "Clear", "Forget", "Login"]) {
    const feedback = new UsageTokenFeedback(saved);
    const earlier = feedback.begin(1, "Reading clipboard");
    const newer = feedback.begin(1, action);
    assert.equal(feedback.ownsIntent(earlier, 1), false);
    assert.equal(feedback.update(earlier, 1, "Late failure"), false);
    assert.equal(feedback.update(earlier, 1, "Late success", true), false);
    assert.equal(feedback.ownsIntent(newer, 1), true);
    assert.equal(feedback.status, action);
  }
});

test("R17: real Token changes retire candidate failures, not newer web progress", () => {
  const feedback = new UsageTokenFeedback(saved);
  const candidate = feedback.begin(1, "Synthetic rejection");
  feedback.observe({ ...saved, usageTokenRevision: 2 });
  assert.equal(feedback.update(candidate, 1, "Late failure"), false);
  assert.equal(feedback.status, "用量 Token 已配置");
  const web = feedback.begin(1, "Waiting for login", "sync");
  feedback.observe({ ...saved, usageTokenRevision: 3 }, true);
  assert.equal(feedback.status, "Waiting for login");
  assert.equal(feedback.update(web, 1, null, true, "sync"), true);
  assert.equal(feedback.status, "用量 Token 已配置");
});

test("R17: current save and clear receipts survive their own early commit event", () => {
  for (const configured of [false, true]) {
    const feedback = new UsageTokenFeedback(saved);
    const owner = feedback.begin(1, "Pending command");
    feedback.observe({
      ...saved,
      usageTokenRevision: 2,
      usageTokenConfigured: configured,
    });
    assert.equal(feedback.update(owner, 1, "Accepted receipt", true), true);
    feedback.observe({
      ...saved,
      usageTokenRevision: 2,
      usageTokenConfigured: configured,
    });
    assert.equal(feedback.status, "Accepted receipt");
    feedback.edit();
    assert.equal(feedback.status.includes("receipt"), false);
  }
});

test("R17: authoritative read errors dominate feedback and do not revive old failures", () => {
  const feedback = new UsageTokenFeedback(saved);
  const owner = feedback.begin(1, "Pending verification");
  feedback.observe({ ...saved, configReadError: "Synthetic root read error" });
  assert.equal(feedback.update(owner, 1, "Late failure"), false);
  assert.equal(feedback.update(owner, 1, "Late success", true), false);
  assert.equal(feedback.status, "Synthetic root read error");
  feedback.observe(saved);
  assert.equal(feedback.update(owner, 1, "Late failure"), false);
  assert.equal(feedback.status, "用量 Token 已配置");
});

test("R17: untrusted config allows local clipboard preparation but hides its status", () => {
  const feedback = new UsageTokenFeedback({
    ...saved,
    configReadError: "Synthetic root read error",
  });
  const owner = feedback.begin(1, "Reading clipboard");
  assert.equal(feedback.ownsIntent(owner, 1), true);
  feedback.begin(2, "Clipboard ready");
  assert.equal(feedback.status, "Synthetic root read error");
});

test("R17: remount feedback starts from committed config, never old page receipts", () => {
  const previous = new UsageTokenFeedback(saved);
  previous.begin(1, "Old receipt");
  const next = new UsageTokenFeedback(saved);
  assert.equal(next.status, "用量 Token 已配置");
});

test("R18: cleanup failure survives edits and ABA without relaxing draft ownership", () => {
  const feedback = new UsageTokenFeedback(saved);
  const draft = feedback.begin(1, null);
  const cleanup = feedback.beginCleanup();
  assert.ok(cleanup);
  feedback.observe({
    ...saved,
    usageTokenRevision: 2,
    usageTokenConfigured: false,
  });
  feedback.edit();
  feedback.edit();
  assert.equal(feedback.update(draft, 3, "Old accepted receipt", true), false);
  assert.equal(feedback.status.includes("监控 Token 已清除"), true);
  assert.equal(feedback.status.includes("正在清理网页登录数据"), true);
  assert.equal(
    feedback.finishCleanup(cleanup, "Synthetic cleanup failure"),
    true,
  );
  const failure = feedback.status;
  feedback.edit();
  feedback.observe({
    ...saved,
    usageTokenRevision: 2,
    usageTokenConfigured: false,
  });
  assert.equal(feedback.status, failure);
  assert.equal(failure.includes("网页登录数据清理尚未确认完成"), true);
  assert.equal(failure.includes("Synthetic cleanup failure"), true);
  assert.equal(failure.includes("重试"), true);
});

test("R18: pre-clear failure does not claim the persisted Token was removed", () => {
  const feedback = new UsageTokenFeedback(saved);
  const cleanup = feedback.beginCleanup();
  assert.ok(cleanup);
  feedback.finishCleanup(cleanup, "Synthetic disk failure");
  assert.equal(feedback.status.startsWith("尚未确认监控 Token 已清除"), true);
  assert.equal(feedback.status.includes("Synthetic disk failure"), true);
});

test("R18: explicit retry has its own cleanup generation and rejects later old results", () => {
  const feedback = new UsageTokenFeedback(saved);
  const old = feedback.beginCleanup();
  assert.ok(old);
  assert.equal(feedback.finishCleanup(old, "First cleanup failure"), true);
  const retry = feedback.beginCleanup();
  assert.ok(retry);
  assert.equal(retry.generation > old.generation, true);
  const waiting = feedback.status;
  assert.equal(feedback.finishCleanup(old, null), false);
  assert.equal(feedback.finishCleanup(old, "Late old failure"), false);
  assert.equal(feedback.status, waiting);
  assert.equal(feedback.finishCleanup(retry, null), true);
  const success = feedback.status;
  assert.equal(feedback.finishCleanup(old, "Even later failure"), false);
  assert.equal(
    feedback.finishCleanup(retry, "Duplicate terminal failure"),
    false,
  );
  assert.equal(feedback.status, success);
});

test("R18: superseded cleanup has its own result, not the newer candidate's status", () => {
  for (const error of [null, "Previous cleanup failure"]) {
    const feedback = new UsageTokenFeedback(saved);
    const cleanup = feedback.beginCleanup();
    assert.ok(cleanup);
    feedback.supersedeCleanup();
    const candidate = feedback.begin(2, "Validating current candidate");
    assert.equal(feedback.finishCleanup(cleanup, error), true);
    assert.equal(
      feedback.status.startsWith("Validating current candidate。"),
      true,
    );
    assert.equal(feedback.status.includes("此前的“退出并忘记账户”"), true);
    feedback.observe({ ...saved, usageTokenRevision: 3 });
    assert.equal(
      feedback.update(candidate, 2, "Current candidate saved", true),
      true,
    );
    assert.equal(feedback.status.startsWith("Current candidate saved。"), true);
    const retry = feedback.beginCleanup();
    assert.ok(retry);
    assert.equal(
      feedback.finishCleanup(cleanup, "Late previous result"),
      false,
    );
    assert.equal(feedback.finishCleanup(retry, null), true);
  }
});

test("R19: trusted account replacement and page disposal retain historical privacy results", () => {
  const cleanupState = new UsageSessionCleanup();
  const previous = new UsageTokenFeedback(saved, cleanupState);
  const cleanup = previous.beginCleanup();
  assert.ok(cleanup);
  const newer = { ...saved, usageTokenRevision: 2 };
  previous.observe(newer);
  previous.edit(); // The page disposes its candidate owner, not the privacy owner.
  const next = new UsageTokenFeedback(newer, cleanupState);
  assert.equal(next.status.includes("此前的“退出并忘记账户”"), true);
  assert.equal(next.status.includes("仍在等待"), true);
  assert.equal(
    previous.finishCleanup(cleanup, "Previous cleanup failure"),
    true,
  );
  assert.equal(next.status.startsWith("用量 Token 已配置。此前的"), true);
  assert.equal(next.status.includes("Previous cleanup failure"), true);
  assert.equal(previous.finishCleanup(cleanup, null), false);
});

test("R18: root read errors dominate without deleting the cleanup failure", () => {
  const feedback = new UsageTokenFeedback(saved);
  const cleanup = feedback.beginCleanup();
  assert.ok(cleanup);
  feedback.observe({ ...saved, configReadError: "Synthetic root read error" });
  feedback.finishCleanup(cleanup, "Synthetic cleanup failure");
  assert.equal(feedback.status, "Synthetic root read error");
  feedback.observe(saved);
  assert.equal(feedback.status.includes("Synthetic cleanup failure"), true);
});
