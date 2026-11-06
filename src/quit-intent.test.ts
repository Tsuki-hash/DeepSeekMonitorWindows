import { test } from "node:test";
import assert from "node:assert/strict";
import { QuitIntentMailbox } from "./quit-intent.ts";
import { QuitRequest, QUIT_RECONCILE_INTERVAL_MS } from "./quit-request.ts";
import type { QuitRequestState } from "./quit-request.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
};

function nativeMailbox() {
  let issued = 0n;
  let acknowledged = 0n;
  let reads = 0;
  const acknowledgements: string[] = [];
  const snapshots: Promise<string | null>[] = [];
  const receipts: Promise<void>[] = [];
  const pending = () => (issued > acknowledged ? String(issued) : null);
  const mailbox = new QuitIntentMailbox(
    () => {
      reads += 1;
      return snapshots.shift() ?? Promise.resolve(pending());
    },
    async (intent) => {
      acknowledgements.push(intent);
      await (receipts.shift() ?? Promise.resolve());
      const sequence = BigInt(intent);
      if (sequence > acknowledged) acknowledged = sequence;
    },
  );
  return {
    mailbox,
    publish: () => String(++issued),
    pending,
    reads: () => reads,
    acknowledgements,
    snapshots,
    receipts,
  };
}

function renderer(mailbox: QuitIntentMailbox) {
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const clock = {
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };
  const registrations: {
    wake: () => void;
    result: ReturnType<typeof deferred<() => void>>;
  }[] = [];
  const states: QuitRequestState[] = [];
  const intents: (() => void)[] = [];
  let commands = 0;
  let releases = 0;
  const owner = new QuitRequest(
    (wake) => {
      const result = deferred<() => void>();
      registrations.push({ wake, result });
      return result.promise;
    },
    async () => {
      commands += 1;
    },
    (action) => intents.push(action),
    (state) => states.push(state),
    undefined,
    mailbox,
    clock,
  );
  return {
    owner,
    registrations,
    accept: (index = 0) =>
      registrations[index].result.resolve(() => {
        releases += 1;
      }),
    intents,
    commands: () => commands,
    releases: () => releases,
    state: () => states[states.length - 1],
    timers,
    tick: () => {
      assert.equal(
        timers.size,
        1,
        "Exactly one reconciliation timer owns work",
      );
      const [id, timer] = [...timers][0];
      assert.equal(timer.delay, QUIT_RECONCILE_INTERVAL_MS);
      timers.delete(id);
      timer.callback();
    },
  };
}

test("R32 quit before native listen resolves is replayed once through the draft guard", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  native.publish(); // No renderer and no event listener yet.
  f.owner.start();
  assert.equal(native.reads(), 0, "Subscribe must finish before the snapshot");
  assert.equal(f.intents.length, 0);
  f.accept();
  await flush();
  assert.equal(f.state().listener, "ready");
  assert.equal(f.intents.length, 1);
  assert.equal(native.pending(), null);
  assert.equal(f.commands(), 0, "Replay is not approval to exit");
  f.registrations[0].wake();
  f.registrations[0].wake();
  await flush();
  assert.equal(
    f.intents.length,
    1,
    "Delayed wake cannot revive consumed intent",
  );
  f.intents[0]();
  f.intents[0]();
  await flush();
  assert.equal(f.commands(), 1);
  f.owner.dispose();
});

test("R32 a wake racing an old snapshot forces a newer read without duplicate approval", async () => {
  const native = nativeMailbox();
  const snapshot = deferred<string | null>();
  native.snapshots.push(snapshot.promise);
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  native.publish();
  f.registrations[0].wake();
  f.registrations[0].wake();
  snapshot.resolve(null);
  await flush();
  assert.equal(native.reads(), 2);
  assert.equal(f.intents.length, 1);
  assert.equal(f.commands(), 0);
  f.owner.dispose();
});

test("R32 failed listener setup retains early native intent for explicit listener retry", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  native.publish();
  f.owner.start();
  f.registrations[0].result.reject(new Error("synthetic registration failure"));
  await flush();
  assert.equal(native.reads(), 0);
  assert.equal(f.state().listener, "failed");
  f.owner.retryListener();
  f.accept(1);
  await flush();
  assert.equal(f.intents.length, 1);
  assert.equal(native.pending(), null);
  f.registrations[0].wake();
  await flush();
  assert.equal(f.intents.length, 1);
  f.owner.dispose();
});

test("R32 failed handshake read releases listener and exposes recovery without consuming intent", async () => {
  const native = nativeMailbox();
  const snapshot = deferred<string | null>();
  native.snapshots.push(snapshot.promise);
  native.publish();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  snapshot.reject(new Error("synthetic snapshot failure"));
  await flush();
  assert.equal(f.state().listener, "failed");
  assert.equal(f.state().recovery, true);
  assert.equal(f.releases(), 1);
  assert.equal(native.pending(), "1");
  f.owner.retryListener();
  f.accept(1);
  await flush();
  assert.equal(f.intents.length, 1);
  assert.equal(f.state().listener, "ready");
  f.owner.dispose();
});

test("R32 failed ack and remount cannot reopen a cancelled draft negotiation", async () => {
  const native = nativeMailbox();
  const receipt = deferred<void>();
  native.receipts.push(receipt.promise);
  native.publish();
  const old = renderer(native.mailbox);
  old.owner.start();
  old.accept();
  await flush();
  assert.equal(old.intents.length, 1);
  // User stays. The guard action is intentionally never executed.
  receipt.reject(new Error("synthetic receipt failure"));
  await flush();
  assert.equal(old.state().listener, "failed");
  old.owner.dispose();
  const current = renderer(native.mailbox);
  current.owner.start();
  current.accept();
  await flush();
  assert.equal(current.intents.length, 0);
  assert.equal(native.pending(), null);
  native.publish();
  current.registrations[0].wake();
  await flush();
  assert.equal(current.intents.length, 1, "Only a new click negotiates again");
  old.intents[0]();
  assert.equal(old.commands(), 0);
  current.owner.dispose();
});

test("R32 snapshot resolved after disposal stays pending for the next owner", async () => {
  const native = nativeMailbox();
  const snapshot = deferred<string | null>();
  native.snapshots.push(snapshot.promise);
  const intent = native.publish();
  const old = renderer(native.mailbox);
  old.owner.start();
  old.accept();
  await flush();
  old.owner.dispose();
  snapshot.resolve(intent);
  await flush();
  assert.equal(old.intents.length, 0);
  assert.equal(native.acknowledgements.length, 0);
  assert.equal(native.pending(), intent);
  const current = renderer(native.mailbox);
  current.owner.start();
  current.accept();
  await flush();
  assert.equal(current.intents.length, 1);
  current.owner.dispose();
});

test("R32 slow acknowledgement does not swallow a newer click or revive the old one", async () => {
  const native = nativeMailbox();
  const receipt = deferred<void>();
  native.receipts.push(receipt.promise);
  native.publish();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  native.publish();
  f.registrations[0].wake();
  receipt.resolve();
  await flush();
  assert.deepEqual(native.acknowledgements, ["1", "2"]);
  assert.equal(f.intents.length, 2);
  f.intents[0]();
  assert.equal(
    f.commands(),
    0,
    "Newer draft negotiation supersedes the old action",
  );
  f.intents[1]();
  await flush();
  assert.equal(f.commands(), 1);
  f.owner.dispose();
});

test("R32 concurrent snapshots and out-of-order old snapshots have one monotonic consumer", async () => {
  let snapshot = "9007199254740993";
  let delivered = 0;
  const mailbox = new QuitIntentMailbox(
    async () => snapshot,
    async () => undefined,
  );
  const consume = () =>
    mailbox.consume(
      () => true,
      () => {
        delivered += 1;
      },
    );
  await Promise.all([consume(), consume()]);
  snapshot = "9007199254740992";
  await consume();
  assert.equal(delivered, 1);
  snapshot = "9007199254740994";
  await consume();
  assert.equal(delivered, 2);
});

test("R32 invalid native intent fails closed without navigation or acknowledgement", async () => {
  for (const intent of [
    "",
    "0",
    "-1",
    "+1",
    "01",
    " 1",
    "1.5",
    "18446744073709551616",
  ]) {
    let delivered = 0;
    let acknowledged = 0;
    const mailbox = new QuitIntentMailbox(
      async () => intent,
      async () => {
        acknowledged += 1;
      },
    );
    await assert.rejects(() =>
      mailbox.consume(
        () => true,
        () => {
          delivered += 1;
        },
      ),
    );
    assert.equal(delivered, 0);
    assert.equal(acknowledged, 0);
  }
});

test("R33 ready listener reconciles a lost wake without a second click or duplicate draft prompt", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  f.owner.start();
  assert.equal(f.timers.size, 0, "Do not poll before listener installation");
  f.accept();
  await flush();
  assert.equal(f.state().listener, "ready");
  native.publish(); // Native persisted the click, but emit delivered no wake.
  assert.equal(f.intents.length, 0);
  f.tick();
  await flush();
  assert.equal(f.intents.length, 1);
  assert.equal(f.commands(), 0, "Polling is not permission to bypass drafts");
  assert.equal(native.pending(), null);
  // Stay/Cancel: never execute the approved-navigation action.
  f.registrations[0].wake();
  await flush();
  f.tick();
  await flush();
  f.tick();
  await flush();
  assert.equal(f.intents.length, 1);
  native.publish(); // A genuinely new click also works with no wake.
  f.tick();
  await flush();
  assert.equal(f.intents.length, 2);
  f.owner.dispose();
  assert.equal(f.timers.size, 0);
});

test("R33 reconciliation joins a slow ack and reads a newer unwoken click without parallel drains", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  const receipt = deferred<void>();
  native.receipts.push(receipt.promise);
  native.publish();
  f.registrations[0].wake();
  await flush();
  assert.equal(f.intents.length, 1);
  const reads = native.reads();
  native.publish(); // The second wake is lost while ack 1 is in flight.
  const deliveredAgain = [...f.timers.values()][0].callback;
  f.tick();
  deliveredAgain();
  assert.equal(f.timers.size, 0, "No new timer until the shared drain settles");
  assert.equal(
    native.reads(),
    reads,
    "The timer must not overlap the slow ack",
  );
  receipt.resolve();
  await flush();
  assert.equal(native.reads(), reads + 1);
  assert.deepEqual(native.acknowledgements, ["1", "2"]);
  assert.equal(f.intents.length, 2);
  assert.equal(f.timers.size, 1);
  f.intents[0]();
  assert.equal(f.commands(), 0, "New intent supersedes old draft approval");
  f.owner.dispose();
});

test("R33 reconciliation read failure exposes recovery and a stale timer cannot affect the retry", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  const staleTimer = [...f.timers.values()][0].callback;
  const snapshot = deferred<string | null>();
  native.snapshots.push(snapshot.promise);
  native.publish();
  f.tick();
  snapshot.reject(new Error("synthetic reconciliation failure"));
  await flush();
  assert.equal(f.state().listener, "failed");
  assert.equal(f.state().recovery, true);
  assert.equal(f.releases(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(native.pending(), "1");
  f.owner.retryListener();
  f.accept(1);
  await flush();
  assert.equal(f.intents.length, 1);
  assert.equal(f.state().listener, "ready");
  const reads = native.reads();
  staleTimer();
  await flush();
  assert.equal(native.reads(), reads);
  assert.equal(
    f.timers.size,
    1,
    "Old timer cannot remove the replacement timer",
  );
  f.owner.dispose();
});

test("R33 failed reconciliation ack retries receipt without reviving a cancelled prompt", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  const receipt = deferred<void>();
  native.receipts.push(receipt.promise);
  native.publish();
  f.tick();
  await flush();
  assert.equal(f.intents.length, 1);
  receipt.reject(new Error("synthetic ack failure"));
  await flush();
  assert.equal(f.state().listener, "failed");
  assert.equal(f.timers.size, 0);
  assert.equal(native.pending(), "1");
  f.owner.retryListener();
  f.accept(1);
  await flush();
  assert.equal(f.intents.length, 1);
  assert.deepEqual(native.acknowledgements, ["1", "1"]);
  assert.equal(native.pending(), null);
  f.tick();
  await flush();
  assert.equal(f.intents.length, 1);
  native.publish();
  f.tick();
  await flush();
  assert.equal(f.intents.length, 2);
  f.owner.dispose();
});

test("R33 unmount revokes an in-flight reconciliation and leaves intent for the next owner", async () => {
  const native = nativeMailbox();
  const old = renderer(native.mailbox);
  old.owner.start();
  old.accept();
  await flush();
  const staleTimer = [...old.timers.values()][0].callback;
  const snapshot = deferred<string | null>();
  native.snapshots.push(snapshot.promise);
  native.publish();
  old.tick();
  old.owner.dispose();
  snapshot.resolve("1");
  await flush();
  assert.equal(old.intents.length, 0);
  assert.equal(native.acknowledgements.length, 0);
  assert.equal(old.timers.size, 0);
  const current = renderer(native.mailbox);
  current.owner.start();
  current.accept();
  await flush();
  const reads = native.reads();
  staleTimer();
  await flush();
  assert.equal(native.reads(), reads);
  assert.equal(current.intents.length, 1);
  assert.equal(current.timers.size, 1);
  current.owner.dispose();
});

test("R33 confirmed quit cancels reconciliation and retained timer callbacks stay inert", async () => {
  const native = nativeMailbox();
  const f = renderer(native.mailbox);
  f.owner.start();
  f.accept();
  await flush();
  native.publish();
  f.tick();
  await flush();
  const staleTimer = [...f.timers.values()][0].callback;
  f.intents[0]();
  await flush();
  assert.equal(f.state().command, "confirmed");
  assert.equal(f.timers.size, 0);
  const reads = native.reads();
  staleTimer();
  await flush();
  assert.equal(native.reads(), reads);
  assert.equal(f.commands(), 1);
  f.owner.dispose();
});

for (const outcome of ["success", "failure"] as const) {
  test(`R33 confirmed quit revokes an in-flight reconciliation read before late ${outcome}`, async () => {
    const native = nativeMailbox();
    const f = renderer(native.mailbox);
    f.owner.start();
    f.accept();
    await flush();
    native.publish();
    f.tick();
    await flush();
    assert.equal(f.intents.length, 1);
    const snapshot = deferred<string | null>();
    native.snapshots.push(snapshot.promise);
    native.publish();
    f.tick();
    await flush();
    const reads = native.reads();
    assert.equal(
      f.timers.size,
      0,
      "The reconciliation read is already in flight",
    );
    f.intents[0]();
    await flush();
    const terminal = f.state();
    assert.equal(terminal.command, "confirmed");
    if (outcome === "success") snapshot.resolve("2");
    else snapshot.reject(new Error("synthetic late read failure"));
    await flush();
    assert.equal(
      f.state(),
      terminal,
      "Late read cannot publish recovery or ready",
    );
    assert.equal(f.intents.length, 1);
    assert.equal(f.commands(), 1);
    assert.deepEqual(native.acknowledgements, ["1"]);
    assert.equal(
      native.pending(),
      "2",
      "Terminal owner does not consume new intent",
    );
    f.registrations[0].wake();
    f.owner.retryListener();
    await flush();
    assert.equal(native.reads(), reads);
    assert.equal(f.timers.size, 0);
    f.owner.dispose();
  });

  test(`R33 confirmed quit ignores late ${outcome} from an already-sent reconciliation ack`, async () => {
    const native = nativeMailbox();
    const f = renderer(native.mailbox);
    f.owner.start();
    f.accept();
    await flush();
    const receipt = deferred<void>();
    native.receipts.push(receipt.promise);
    native.publish();
    f.tick();
    await flush();
    assert.deepEqual(native.acknowledgements, ["1"]);
    f.intents[0]();
    await flush();
    const terminal = f.state();
    const reads = native.reads();
    assert.equal(terminal.command, "confirmed");
    if (outcome === "success") receipt.resolve();
    else receipt.reject(new Error("synthetic late ack failure"));
    await flush();
    assert.equal(
      f.state(),
      terminal,
      "An issued ack may settle, but cannot change terminal UI",
    );
    assert.equal(f.intents.length, 1);
    assert.equal(f.commands(), 1);
    assert.equal(f.timers.size, 0);
    f.registrations[0].wake();
    await flush();
    assert.equal(native.reads(), reads);
    f.owner.dispose();
  });
}
