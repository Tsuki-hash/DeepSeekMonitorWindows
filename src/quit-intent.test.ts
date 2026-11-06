import { test } from "node:test";
import assert from "node:assert/strict";
import { QuitIntentMailbox } from "./quit-intent.ts";
import { QuitRequest } from "./quit-request.ts";
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
