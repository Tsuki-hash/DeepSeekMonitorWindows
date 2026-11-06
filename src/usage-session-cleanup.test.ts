import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageSessionCleanup } from "./usage-session-cleanup.ts";
import { UsageTokenFeedback } from "./usage-token-feedback.ts";

const saved = {
  usageTokenRevision: 1,
  usageTokenConfigured: true,
  configReadError: null as string | null,
};
const cleared = {
  ...saved,
  usageTokenRevision: 2,
  usageTokenConfigured: false,
};

for (const result of [
  null,
  "Synthetic cleanup failure",
  "网页登录数据仍在清理；完成前无法重新同步",
]) {
  for (const timing of ["before", "away", "after"]) {
    test(`R19: ${result ?? "success"} is retained ${timing} settings remount`, () => {
      const cleanup = new UsageSessionCleanup();
      const oldPage = new UsageTokenFeedback(saved, cleanup);
      const draft = oldPage.begin(1, "Old draft");
      const owner = cleanup.begin(saved);
      assert.ok(owner);
      cleanup.observe(cleared); // Global config subscription, not a page effect.
      oldPage.observe(cleared);
      if (timing === "before") cleanup.finish(owner, result);
      oldPage.edit(); // Dispose candidate ownership only.
      if (timing === "away") cleanup.finish(owner, result);
      const nextPage = new UsageTokenFeedback(cleared, cleanup);
      nextPage.begin(1, "New candidate");
      if (timing === "after") cleanup.finish(owner, result);
      assert.equal(oldPage.update(draft, 1, "Obsolete receipt", true), false);
      assert.equal(nextPage.status.startsWith("New candidate。"), true);
      assert.equal(
        nextPage.status.includes("监控 Token 已清除"),
        result !== null,
      );
      assert.equal(
        nextPage.status.includes("已清除监控 Token 和应用内网页登录数据"),
        result === null,
      );
      if (result) assert.equal(nextPage.status.includes(result), true);
      assert.equal(cleanup.snapshot?.owner, owner);
      assert.equal(cleanup.snapshot?.tokenRevision, saved.usageTokenRevision);
      assert.equal(cleanup.snapshot?.tokenCleared, true);
      assert.equal(
        cleanup.snapshot?.phase,
        result === null ? "succeeded" : "failed",
      );
    });
  }
}

test("R19: pending cleanup outlives subscribers, blocks duplicates and never owns new drafts", () => {
  const cleanup = new UsageSessionCleanup();
  const owner = cleanup.begin(saved);
  assert.ok(owner);
  let notices = 0;
  const unsubscribe = cleanup.subscribe(() => notices++);
  cleanup.observe(cleared);
  assert.equal(notices, 1);
  unsubscribe();
  const page = new UsageTokenFeedback(cleared, cleanup);
  page.begin(1, "New page candidate");
  page.edit();
  page.edit(); // Same-text ABA remains a draft edit, not account replacement.
  assert.equal(cleanup.begin(cleared), null);
  assert.equal(cleanup.snapshot?.owner, owner);
  assert.equal(cleanup.snapshot?.superseded, false);
  assert.equal(page.status.includes("正在清理网页登录数据"), true);
  cleanup.finish(owner, "Synthetic failure after unsubscribe");
  assert.equal(notices, 1);
  assert.equal(
    page.status.includes("Synthetic failure after unsubscribe"),
    true,
  );
});

test("R19: committed new account while settings is absent keeps old cleanup historical", () => {
  const cleanup = new UsageSessionCleanup();
  const owner = cleanup.begin(saved);
  assert.ok(owner);
  cleanup.observe(cleared);
  const replacement = { ...saved, usageTokenRevision: 3 };
  cleanup.observe(replacement);
  const page = new UsageTokenFeedback(replacement, cleanup);
  assert.equal(page.status.startsWith("用量 Token 已配置。此前的"), true);
  assert.equal(page.status.includes("不代表当前账户已退出"), true);
  cleanup.finish(owner, "Old account cleanup failure");
  assert.equal(page.status.includes("Old account cleanup failure"), true);
  assert.equal(page.status.includes("重新确认"), true);
  assert.equal(cleanup.snapshot?.tokenRevision, saved.usageTokenRevision);
  const oldResult = cleanup.snapshot;
  cleanup.observe(cleared); // This cannot undo historical attribution.
  assert.equal(cleanup.snapshot, oldResult);
  const retry = cleanup.begin(replacement); // Explicit action only.
  assert.ok(retry);
  assert.equal(retry.generation > owner.generation, true);
  assert.equal(cleanup.snapshot?.tokenRevision, replacement.usageTokenRevision);
  assert.equal(cleanup.snapshot?.superseded, false);
  assert.equal(cleanup.snapshot?.tokenCleared, false);
  assert.equal(cleanup.finish(owner, null), false);
  assert.equal(cleanup.finish(owner, "Late old failure"), false);
  assert.equal(cleanup.snapshot?.phase, "pending");
  assert.equal(cleanup.finish(retry, null), true);
  assert.equal(cleanup.finish(retry, "Duplicate terminal result"), false);
});

test("R19: only app reset retires privacy owners; old callbacks cannot finish a later operation", () => {
  const cleanup = new UsageSessionCleanup();
  const owner = cleanup.begin(saved);
  assert.ok(owner);
  cleanup.reset();
  const next = cleanup.begin(saved);
  assert.ok(next);
  assert.equal(next.generation > owner.generation, true);
  assert.equal(cleanup.finish(owner, null), false);
  assert.equal(cleanup.snapshot?.owner, next);
  assert.equal(cleanup.finish(next, "Synthetic current failure"), true);
});

for (const configured of [false, true]) {
  test(`R19: durable marker after restart remains unconfirmed with current account configured=${configured}`, () => {
    const cleanup = new UsageSessionCleanup();
    const reopened = {
      ...saved,
      // Deliberately reuse the old process-local revision. It cannot prove
      // account identity across restart, even if the current Token text is ABA.
      usageTokenConfigured: configured,
      usageCleanupUnconfirmed: "9007199254740993",
    };
    cleanup.observe(reopened);
    const owner = cleanup.snapshot?.owner;
    assert.ok(owner);
    const page = new UsageTokenFeedback(reopened, cleanup);
    assert.equal(cleanup.snapshot?.phase, "unconfirmed");
    assert.equal(cleanup.snapshot?.persistedOperationId, "9007199254740993");
    assert.equal(cleanup.pending, false);
    assert.equal(page.status.includes("应用重新打开后无法确认"), true);
    assert.equal(page.status.includes("这不代表当前账户已退出"), true);
    assert.equal(page.status.includes("重新确认"), true);
    assert.equal(cleanup.finish(owner, null), false);
    cleanup.observe({ ...reopened, usageCleanupUnconfirmed: null });
    assert.equal(cleanup.snapshot?.phase, "unconfirmed");
    const retry = cleanup.begin(reopened);
    assert.ok(retry);
    cleanup.observe({
      ...cleared,
      usageCleanupUnconfirmed: "9007199254740994",
    });
    assert.equal(cleanup.snapshot?.persistedOperationId, "9007199254740994");
    assert.equal(cleanup.finish(owner, null), false);
    assert.equal(cleanup.finish(retry, null), true);
    assert.equal(
      page.status.includes("已清除监控 Token 和应用内网页登录数据"),
      true,
    );
  });
}

test("R19: owned live marker does not masquerade as restart or disappear on confirmation event", () => {
  const cleanup = new UsageSessionCleanup();
  const owner = cleanup.begin(saved);
  assert.ok(owner);
  cleanup.observe({ ...cleared, usageCleanupUnconfirmed: "1" });
  assert.equal(cleanup.snapshot?.owner, owner);
  assert.equal(cleanup.snapshot?.phase, "pending");
  cleanup.observe({ ...cleared, usageCleanupUnconfirmed: null });
  assert.equal(cleanup.snapshot?.phase, "pending");
  assert.equal(cleanup.finish(owner, null), true);
});
