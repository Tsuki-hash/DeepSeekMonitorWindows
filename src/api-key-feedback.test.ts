import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiKeyFeedback } from "./api-key-feedback.ts";

const saved = {
  apiKeyRevision: 1,
  apiKeyConfigured: true,
  apiKeyPreview: "sk-…synthetic",
  configReadError: null as string | null,
};

test("R16-01: first trusted read and unrelated snapshots preserve candidate feedback", () => {
  for (const message of [
    "正在验证 API Key…",
    "Synthetic verification failure",
  ]) {
    const feedback = new ApiKeyFeedback(null);
    const owner = feedback.begin(1, message);
    feedback.observe(saved);
    feedback.observe({ ...saved });
    assert.equal(feedback.status, message);
    assert.equal(feedback.owns(owner, 1), true);
  }
});

test("R16-01: real Key changes invalidate failures, including same-value revalidation", () => {
  for (const next of [
    { ...saved, apiKeyRevision: 2 },
    { ...saved, apiKeyConfigured: false, apiKeyPreview: null },
    { ...saved, apiKeyPreview: "sk-…other" },
  ]) {
    const feedback = new ApiKeyFeedback(saved);
    const owner = feedback.begin(1, "Synthetic failure");
    feedback.observe(next);
    assert.equal(feedback.update(owner, 1, "Late failure"), false);
    assert.equal(feedback.status.includes("failure"), false);
  }
});

test("R16-01: authoritative root errors revoke pending feedback and recover cleanly", () => {
  const feedback = new ApiKeyFeedback(saved);
  const owner = feedback.begin(1, "正在验证 API Key…");
  feedback.observe({
    ...saved,
    configReadError: "Synthetic unreadable config",
  });
  assert.equal(feedback.update(owner, 1, "Late failure"), false);
  assert.equal(feedback.update(owner, 1, "Success receipt", true), false);
  assert.equal(feedback.status, "Synthetic unreadable config");
  feedback.observe(saved);
  assert.equal(feedback.update(owner, 1, "Late failure"), false);
  assert.equal(feedback.status, "已配置 sk-…synthetic");
});

test("R16-01: accepted current success receipts can cross their own commit broadcast", () => {
  const feedback = new ApiKeyFeedback(saved);
  const owner = feedback.begin(1, "正在验证 API Key…");
  feedback.observe({ ...saved, apiKeyRevision: 2 });
  assert.equal(feedback.update(owner, 1, "验证通过", true), true);
  feedback.observe({ ...saved, apiKeyRevision: 2 });
  assert.equal(feedback.status, "验证通过");
  feedback.edit();
  assert.equal(feedback.update(owner, 2, "Late receipt", true), false);
});

test("R16-01: edits, ABA revisions and newer failed attempts own their feedback", () => {
  const feedback = new ApiKeyFeedback(saved);
  const old = feedback.begin(1, "Pending A");
  feedback.edit();
  feedback.edit();
  assert.equal(feedback.update(old, 3, "Failure A"), false);
  const next = feedback.begin(3, "Pending B");
  assert.equal(feedback.update(next, 3, "Failure B"), true);
  feedback.observe({ ...saved });
  assert.equal(feedback.update(old, 1, "Late success A", true), false);
  assert.equal(feedback.status, "Failure B");
});

test("R16-01: a fresh page starts from saved state rather than old page feedback", () => {
  const previous = new ApiKeyFeedback(saved);
  previous.begin(1, "Old page failure");
  assert.equal(new ApiKeyFeedback(saved).status, "已配置 sk-…synthetic");
  const firstError = new ApiKeyFeedback(null);
  firstError.begin(1, "Pending");
  firstError.observe({ ...saved, configReadError: "Unreadable" });
  firstError.observe(saved);
  assert.equal(firstError.status, "已配置 sk-…synthetic");
});

test("R16-01: accepted snapshots clear read failures without clearing candidate failures", () => {
  const feedback = new ApiKeyFeedback(null);
  feedback.readFailed(feedback.capture(0), 0, "Synthetic initial read failure");
  assert.equal(feedback.status, "Synthetic initial read failure");
  feedback.observe(saved);
  assert.equal(feedback.status, "已配置 sk-…synthetic");
  const staleRead = feedback.capture(1);
  feedback.begin(1, "Synthetic candidate failure");
  feedback.readFailed(staleRead, 1, "Synthetic late read failure");
  feedback.observe({ ...saved });
  assert.equal(feedback.status, "Synthetic candidate failure");
});

test("R16-01: untrusted configuration does not own local clipboard draft edits", () => {
  const feedback = new ApiKeyFeedback({
    ...saved,
    configReadError: "Unreadable",
  });
  const owner = feedback.begin(1, "Reading clipboard");
  assert.equal(feedback.ownsIntent(owner, 1), true);
  assert.equal(feedback.owns(owner, 1), false);
  feedback.begin(2, "Clipboard read");
  assert.equal(feedback.status, "Unreadable");
});
