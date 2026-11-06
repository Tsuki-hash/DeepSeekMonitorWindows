import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newUsageSyncRequest,
  UsageSyncOwner,
  UsageSyncRequests,
} from "./usage-sync-owner.ts";
import type { UsageSyncStatus } from "./types";
const status = (
  requestId: string,
  generation: number,
  active = false,
): UsageSyncStatus => ({
  requestId,
  generation,
  active,
  kind: "web",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("R14: clear includes every unresolved start and gates new intent without retaining Tokens", async () => {
  const requests = new UsageSyncRequests();
  const web = deferred<void>();
  const manual = deferred<void>();
  const clearing = deferred<void>();
  const oldWeb = requests.start("old-web", () => web.promise);
  const oldManual = requests.start("old-manual", () => manual.promise);
  let cancelled: string[] = [];
  const clear = requests.clear((ids) => {
    cancelled = ids;
    return clearing.promise;
  });
  let newStarted = false;
  const next = requests.start("new-web", async () => {
    newStarted = true;
  });
  await Promise.resolve();
  assert.deepEqual(cancelled, ["old-web", "old-manual"]);
  assert.equal(newStarted, false);
  clearing.resolve();
  await clear;
  await next;
  assert.equal(newStarted, true);
  // Late replies only release their own request IDs, not the new owner.
  web.resolve();
  manual.resolve();
  await Promise.all([oldWeb, oldManual]);
  await requests.clear(async (ids) => assert.deepEqual(ids, []));
});

test("R14: consecutive clears snapshot intent before waiting for an earlier clear", async () => {
  const requests = new UsageSyncRequests();
  const firstGate = deferred<void>();
  const oldGate = deferred<void>();
  const old = requests.start("old", () => oldGate.promise);
  const snapshots: string[][] = [];
  const first = requests.clear((ids) => {
    snapshots.push(ids);
    return firstGate.promise;
  });
  const between = requests.start("between-clears", async () => undefined);
  const second = requests.clear(async (ids) => {
    snapshots.push(ids);
  });
  const after = requests.start("after-both-clears", async () => undefined);
  firstGate.resolve();
  await Promise.all([first, between, second, after]);
  assert.deepEqual(snapshots, [["old"], ["old", "between-clears"]]);
  oldGate.resolve();
  await old;
});

test("R14: failed clear stays rejected while a later explicit login can proceed", async () => {
  const requests = new UsageSyncRequests();
  const failure = deferred<void>();
  const clearing = requests.clear(() => failure.promise);
  const rejection = assert.rejects(() => clearing);
  let newStarted = false;
  const next = requests.start("retry-after-failure", async () => {
    newStarted = true;
  });
  failure.reject(new Error("synthetic clear failure"));
  await rejection;
  await next;
  assert.equal(newStarted, true);
});

test("R14: each new start carries all older unresolved intents, not a newer owner", async () => {
  const requests = new UsageSyncRequests();
  const webGate = deferred<void>();
  const manualGate = deferred<void>();
  const snapshots: string[][] = [];
  const web = requests.start("web-one", (ids) => {
    snapshots.push(ids);
    return webGate.promise;
  });
  const manual = requests.start("manual-two", (ids) => {
    snapshots.push(ids);
    return manualGate.promise;
  });
  const newest = requests.start("web-three", async (ids) => {
    snapshots.push(ids);
  });
  await newest;
  assert.deepEqual(snapshots, [[], ["web-one"], ["web-one", "manual-two"]]);
  manualGate.resolve();
  webGate.resolve();
  await Promise.all([web, manual]);
});
