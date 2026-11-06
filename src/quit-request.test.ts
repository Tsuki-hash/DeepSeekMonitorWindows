import { test } from "node:test";
import assert from "node:assert/strict";
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
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};
function fixture() {
  const registrations: {
    callback: () => void;
    result: ReturnType<typeof deferred<() => void>>;
  }[] = [];
  const states: QuitRequestState[] = [];
  const intents: (() => void)[] = [];
  let commands = 0;
  let confirm: () => Promise<unknown> = async () => undefined;
  const owner = new QuitRequest(
    (callback) => {
      const result = deferred<() => void>();
      registrations.push({ callback, result });
      return result.promise;
    },
    () => {
      commands += 1;
      return confirm();
    },
    (intent) => intents.push(intent),
    (state) => states.push(state),
  );
  return {
    owner,
    registrations,
    states,
    intents,
    commands: () => commands,
    setConfirm: (next: typeof confirm) => (confirm = next),
    state: () => states[states.length - 1],
  };
}

test("R31 listener rejection is observable, retry is single-flight and stale callbacks are inert", async () => {
  const f = fixture();
  f.owner.start();
  f.registrations[0].result.reject(new Error("synthetic only"));
  await flush();
  assert.equal(f.state().listener, "failed");
  assert.equal(f.state().recovery, true);
  f.registrations[0].callback();
  assert.equal(f.intents.length, 0);
  f.owner.retryListener();
  f.owner.retryListener();
  f.owner.start();
  assert.equal(f.registrations.length, 2);
  assert.equal(f.state().listener, "registering");
  f.registrations[0].callback();
  assert.equal(f.intents.length, 0);
  let released = 0;
  f.registrations[1].result.resolve(() => released++);
  await flush();
  assert.equal(f.state().listener, "ready");
  assert.equal(f.commands(), 0, "Listener recovery never replays a lost quit");
  f.registrations[1].callback();
  assert.equal(f.intents.length, 1);
  assert.equal(f.commands(), 0, "The draft guard still owns permission");
  f.owner.dispose();
  f.owner.dispose();
  assert.equal(released, 1);
  f.registrations[1].callback();
  f.intents[0]();
  assert.equal(f.commands(), 0);
});

for (const outcome of ["success", "failure"] as const) {
  test(`R31 unmount revokes pending listener ${outcome}`, async () => {
    const f = fixture();
    f.owner.start();
    f.owner.dispose();
    const published = f.states.length;
    f.registrations[0].callback();
    let released = 0;
    if (outcome === "success")
      f.registrations[0].result.resolve(() => released++);
    else f.registrations[0].result.reject(new Error("synthetic only"));
    await flush();
    assert.equal(released, outcome === "success" ? 1 : 0);
    assert.equal(f.states.length, published);
    assert.equal(f.intents.length, 0);
    f.owner.retryListener();
    f.owner.requestQuit();
    f.owner.start();
    assert.equal(f.registrations.length, 1);
    assert.equal(f.commands(), 0);
  });
}

test("R31 command failure retry asks the draft guard again and deduplicates pending and confirmed commands", async () => {
  const f = fixture();
  f.owner.start();
  f.registrations[0].result.resolve(() => undefined);
  const first = deferred<void>();
  f.setConfirm(() => first.promise);
  f.owner.requestQuit();
  f.intents[0]();
  f.intents[0]();
  f.registrations[0].callback();
  f.owner.requestQuit();
  assert.equal(f.commands(), 1);
  assert.equal(f.intents.length, 1);
  first.reject(new Error("synthetic only"));
  await flush();
  assert.equal(f.state().command, "failed");
  f.intents[0]();
  assert.equal(f.commands(), 1, "Failed commands cannot reuse old approval");
  f.owner.requestQuit();
  assert.equal(f.intents.length, 2);
  assert.equal(f.commands(), 1, "New drafts must get a fresh negotiation");
  f.intents[0]();
  assert.equal(f.commands(), 1, "The previously approved action is stale");
  f.setConfirm(async () => undefined);
  f.intents[1]();
  await flush();
  assert.equal(f.commands(), 2);
  assert.equal(f.state().command, "confirmed");
  f.owner.requestQuit();
  f.intents[1]();
  assert.equal(f.commands(), 2);
  f.owner.dispose();
});

test("R31 safe quit works without a listener, only after the shared guard approves", async () => {
  const f = fixture();
  f.owner.start();
  f.registrations[0].result.reject(new Error("synthetic only"));
  await flush();
  f.owner.requestQuit();
  assert.equal(f.commands(), 0);
  f.owner.requestQuit();
  f.intents[0]();
  assert.equal(f.commands(), 0, "A superseded guard action cannot quit");
  f.intents[1]();
  await flush();
  assert.equal(f.commands(), 1);
  assert.equal(f.state().listener, "failed");
  f.owner.dispose();
});

for (const outcome of ["success", "failure"] as const) {
  test(`R31 disposed command ${outcome} cannot publish into a replayed owner`, async () => {
    const old = fixture();
    const command = deferred<void>();
    old.setConfirm(() => command.promise);
    old.owner.start();
    old.registrations[0].result.resolve(() => undefined);
    old.owner.requestQuit();
    old.intents[0]();
    old.owner.dispose();
    const published = old.states.length;
    const current = fixture();
    current.owner.start();
    current.registrations[0].result.resolve(() => undefined);
    if (outcome === "success") command.resolve();
    else command.reject(new Error("synthetic only"));
    await flush();
    assert.equal(old.states.length, published);
    assert.equal(current.state().command, "idle");
    assert.equal(current.commands(), 0);
    current.owner.dispose();
  });
}

test("R31 synchronous listener/command throws and cleanup failures are contained", async () => {
  const states: QuitRequestState[] = [];
  const owner = new QuitRequest(
    () => {
      throw new Error("synthetic listener failure");
    },
    () => {
      throw new Error("synthetic command failure");
    },
    (action) => action(),
    (state) => states.push(state),
  );
  owner.start();
  await flush();
  assert.equal(states[states.length - 1].listener, "failed");
  owner.requestQuit();
  await flush();
  assert.equal(states[states.length - 1].command, "failed");
  owner.dispose();
  for (const off of [
    () => {
      throw new Error("synthetic cleanup failure");
    },
    async () => {
      throw new Error("synthetic async cleanup failure");
    },
  ]) {
    const f = fixture();
    f.owner.start();
    f.registrations[0].result.resolve(off);
    await flush();
    f.owner.dispose();
    f.registrations[0].callback();
    await flush();
    assert.equal(f.intents.length, 0);
  }
});
