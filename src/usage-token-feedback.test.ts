import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTokenFeedback } from "./usage-token-feedback.ts";

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
