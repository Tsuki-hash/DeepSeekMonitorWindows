import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UsageSyncReconciler,
  USAGE_SYNC_RECONCILE_MS,
} from "./usage-sync-reconcile.ts";

const flush = async () => {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let id = 0;
  let needed = false;
  let reads = 0;
  let released = 0;
  const timers = new Map<number, () => void>();
  const installations: {
    current: () => boolean;
    result: ReturnType<typeof deferred<() => void>>;
  }[] = [];
  const listenerErrors: boolean[] = [];
  const readErrors: unknown[] = [];
  const pending: ReturnType<typeof deferred<void>>[] = [];
  const currents: (() => boolean)[] = [];
  const reconciler = new UsageSyncReconciler({
    subscriptions: [
      async (current) => {
        const result = deferred<() => void>();
        installations.push({ current, result });
        return result.promise;
      },
    ],
    reconcile: async (current) => {
      reads += 1;
      currents.push(current);
      await pending.shift()?.promise;
    },
    needed: () => needed,
    listenerError: (failed) => listenerErrors.push(failed),
    readError: (error) => readErrors.push(error),
    clock: {
      setTimeout: (callback, delay) => {
        assert.equal(delay, USAGE_SYNC_RECONCILE_MS);
        timers.set(++id, callback);
        return id;
      },
      clearTimeout: (timer) => {
        timers.delete(timer);
      },
    },
  });
  const accept = (index = 0) =>
    installations[index].result.resolve(() => {
      released += 1;
    });
  const tick = () => {
    assert.equal(timers.size, 1);
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
  };
  return {
    reconciler,
    accept,
    tick,
    timers,
    installations,
    listenerErrors,
    readErrors,
    pending,
    currents,
    reads: () => reads,
    released: () => released,
    needed: (value: boolean) => {
      needed = value;
    },
  };
}

test("R34 sync reconciliation sleeps when idle and polls an active session without events", async () => {
  const f = fixture();
  f.reconciler.start();
  assert.equal(f.reads(), 0, "Subscription precedes initial restoration");
  f.accept();
  await flush();
  assert.equal(f.reads(), 1);
  assert.equal(f.timers.size, 0);
  f.needed(true);
  f.reconciler.request();
  f.tick();
  await flush();
  assert.equal(f.reads(), 2);
  assert.equal(f.timers.size, 1);
  f.needed(false);
  f.tick();
  await flush();
  assert.equal(f.reads(), 2);
  assert.equal(f.timers.size, 0);
  f.reconciler.dispose();
});

test("R34 sync reconciliation is single-flight and retries a failed read on its bounded timer", async () => {
  const f = fixture();
  const read = deferred<void>();
  f.pending.push(read);
  f.needed(true);
  f.reconciler.start();
  f.accept();
  await flush();
  f.reconciler.request();
  f.reconciler.request();
  assert.equal(f.reads(), 1);
  assert.equal(f.timers.size, 0);
  read.reject(new Error("Synthetic status failure"));
  await flush();
  assert.equal(f.readErrors.length, 1);
  f.tick();
  await flush();
  assert.equal(f.reads(), 2);
  assert.equal(f.readErrors.at(-1), null);
  f.reconciler.dispose();
});

test("R34 failed sync subscription retries and its rejected callback owner stays revoked", async () => {
  const f = fixture();
  f.reconciler.start();
  f.installations[0].result.reject(new Error("Synthetic listener failure"));
  await flush();
  assert.equal(f.installations[0].current(), false);
  assert.deepEqual(f.listenerErrors, [true]);
  assert.equal(
    f.reads(),
    1,
    "Restoration still works without a notification listener",
  );
  f.tick();
  assert.equal(f.installations.length, 2);
  f.accept(1);
  await flush();
  assert.equal(f.installations[0].current(), false);
  assert.equal(f.installations[1].current(), true);
  assert.deepEqual(f.listenerErrors, [true, false]);
  assert.equal(f.timers.size, 0);
  f.reconciler.dispose();
  assert.equal(f.released(), 1);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`R34 unmounted sync owner ignores a late ${outcome} from an in-flight read`, async () => {
    const f = fixture();
    const read = deferred<void>();
    f.pending.push(read);
    f.needed(true);
    f.reconciler.start();
    f.accept();
    await flush();
    const errors = f.readErrors.length;
    f.reconciler.dispose();
    assert.equal(f.currents[0](), false);
    if (outcome === "resolve") read.resolve();
    else read.reject(new Error("Synthetic abandoned failure"));
    await flush();
    assert.equal(f.readErrors.length, errors);
    assert.equal(f.timers.size, 0);
    assert.equal(f.released(), 1);
  });
}

test("R34 disposed sync owner releases late listeners and ignores retained timer callbacks", async () => {
  const installing = fixture();
  installing.reconciler.start();
  installing.reconciler.dispose();
  installing.accept();
  await flush();
  assert.equal(installing.reads(), 0);
  assert.equal(installing.released(), 1);
  const f = fixture();
  f.needed(true);
  f.reconciler.start();
  f.accept();
  await flush();
  const stale = [...f.timers.values()][0];
  f.reconciler.dispose();
  stale();
  await flush();
  assert.equal(f.reads(), 1);
  assert.equal(f.timers.size, 0);
});
