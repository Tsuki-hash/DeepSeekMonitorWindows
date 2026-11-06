import { test } from "node:test";
import assert from "node:assert/strict";
import { newUsageSyncRequest, UsageSyncOwner } from "./usage-sync-owner.ts";
import type { UsageSyncStatus } from "./types";
const status = (requestId: string, generation: number, active = false): UsageSyncStatus => ({
  requestId, generation, active, kind: "web",
});

test("N10: first late capture/ended from old session cannot stop a newer pending start", () => {
  const owner = new UsageSyncOwner();
  owner.begin("G2");
  assert.equal(owner.accept(status("G1", 1)), false);
  assert.equal(owner.accept(status("G2", 2, true)), true);
  assert.equal(owner.accept(status("G1", 1)), false);
  assert.equal(owner.ended, false);
});

test("N10: terminal state cannot be resurrected by a delayed start response", () => {
  const owner = new UsageSyncOwner();
  owner.begin("G1");
  assert.equal(owner.accept(status("G1", 1)), true);
  assert.equal(owner.accept(status("G1", 1, true)), false);
  owner.begin("G3");
  assert.equal(owner.finish("G1"), false);
  assert.equal(owner.ended, false);
});

test("N10: remount restores exact backend generation and ignores mismatched events", () => {
  const owner = new UsageSyncOwner();
  owner.restore(status("G3", 3, true));
  assert.equal(owner.accept(status("G2", 2)), false);
  assert.equal(owner.accept(status("G3", 2)), false);
  assert.equal(owner.accept(status("G3", 3)), true);
  assert.notEqual(newUsageSyncRequest(), newUsageSyncRequest());
});
