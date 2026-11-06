import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
  newApiKeyRequest,
  ApiKeyRequests,
} from "./api-key-operation.ts";

test("Key操作跨设置页面生命周期：清除或新保存拒绝旧响应", () => {
  const saving = beginApiKeyOperation();
  const clearing = beginApiKeyOperation();
  assert.equal(isCurrentApiKeyOperation(saving), false);
  assert.equal(isCurrentApiKeyOperation(clearing), true);
  const newerSave = beginApiKeyOperation();
  assert.equal(isCurrentApiKeyOperation(clearing), false);
  assert.equal(isCurrentApiKeyOperation(newerSave), true);
});

import {
  beginUsageTokenOperation,
  isCurrentUsageTokenOperation,
} from "./api-key-operation.ts";
test("N05: Token operation ownership spans page remounts and stays independent of Key", () => {
  const token = beginUsageTokenOperation();
  const key = beginApiKeyOperation();
  assert.equal(isCurrentUsageTokenOperation(token), true);
  const newerToken = beginUsageTokenOperation();
  assert.equal(isCurrentUsageTokenOperation(token), false);
  assert.equal(isCurrentUsageTokenOperation(newerToken), true);
  assert.equal(isCurrentApiKeyOperation(key), true);
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

test("R15: Key request IDs are unique and do not contain credential input", () => {
  const first = newApiKeyRequest();
  const second = newApiKeyRequest();
  assert.notEqual(first, second);
  assert.ok(first.length <= 128);
  assert.ok(second.length <= 128);
});

test("R15: Key clear captures every unresolved save and gates later explicit intent", async () => {
  const requests = new ApiKeyRequests();
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const clearGate = deferred<void>();
  const snapshots: string[][] = [];
  const first = requests.save("old-key", (ids) => {
    snapshots.push(ids);
    return firstGate.promise;
  });
  const second = requests.save("replacement-key", (ids) => {
    snapshots.push(ids);
    return secondGate.promise;
  });
  let cancelled: string[] = [];
  const clearing = requests.clear((ids) => {
    cancelled = ids;
    return clearGate.promise;
  });
  let started = false;
  const latest = requests.save("explicit-new-key", async (ids) => {
    snapshots.push(ids);
    started = true;
  });
  await Promise.resolve();
  assert.deepEqual(cancelled, ["old-key", "replacement-key"]);
  assert.deepEqual(snapshots, [[], ["old-key"]]);
  assert.equal(started, false);
  clearGate.resolve();
  await clearing;
  await latest;
  assert.equal(started, true);
  assert.deepEqual(snapshots[2], ["old-key", "replacement-key"]);
  firstGate.resolve();
  secondGate.resolve();
  await Promise.all([first, second]);
  await requests.clear(async (ids) => assert.deepEqual(ids, []));
});

test("R15: consecutive Key clears snapshot intent before their barrier settles", async () => {
  const requests = new ApiKeyRequests();
  const oldGate = deferred<void>();
  const clearGate = deferred<void>();
  const old = requests.save("old-key", () => oldGate.promise);
  const snapshots: string[][] = [];
  const first = requests.clear((ids) => {
    snapshots.push(ids);
    return clearGate.promise;
  });
  const between = requests.save("between-clears", async () => undefined);
  const second = requests.clear(async (ids) => {
    snapshots.push(ids);
  });
  const latest = requests.save("after-both-clears", async () => undefined);
  clearGate.resolve();
  await Promise.all([first, between, second, latest]);
  assert.deepEqual(snapshots, [["old-key"], ["old-key", "between-clears"]]);
  oldGate.resolve();
  await old;
});

test("R15: failed Key clear preserves its rejection but releases explicit retry", async () => {
  const requests = new ApiKeyRequests();
  const gate = deferred<void>();
  const clearing = requests.clear(() => gate.promise);
  const rejected = assert.rejects(() => clearing);
  let started = false;
  const retry = requests.save("retry-key", async () => {
    started = true;
  });
  assert.equal(started, false);
  gate.reject(new Error("Synthetic clear failure"));
  await rejected;
  await retry;
  assert.equal(started, true);
});

test("R15: Key clear barrier is independent of the Token request owner", async () => {
  const { UsageSyncRequests } = await import("./usage-sync-owner.ts");
  const key = new ApiKeyRequests();
  const token = new UsageSyncRequests();
  const gate = deferred<void>();
  const clearing = key.clear(() => gate.promise);
  let loginStarted = false;
  await token.start("web-login", async (ids) => {
    loginStarted = true;
    assert.deepEqual(ids, []);
  });
  assert.equal(loginStarted, true);
  gate.resolve();
  await clearing;
});
