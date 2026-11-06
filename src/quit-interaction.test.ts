import { test } from "node:test";
import assert from "node:assert/strict";
import { QuitInteractionGate } from "./quit-interaction.ts";
import { QuitRequest } from "./quit-request.ts";

test("R32 exit lock is synchronous, owned, and invalidates old async edits", () => {
  const gate = new QuitInteractionGate();
  const paste = gate.capture();
  const seen: boolean[] = [];
  const unsubscribe = gate.subscribe(() => seen.push(gate.allowed()));
  const oldRelease = gate.lock();
  assert.equal(gate.allowed(), false);
  assert.equal(paste(), false);
  assert.deepEqual(seen, [false]);
  const release = gate.lock();
  oldRelease();
  assert.equal(gate.allowed(), false);
  release();
  assert.equal(gate.allowed(), true);
  assert.equal(
    paste(),
    false,
    "Failure must not revive pre-exit clipboard work",
  );
  assert.equal(gate.capture()(), true);
  unsubscribe();
});

for (const outcome of ["success", "failure", "throw"] as const) {
  test(`R32 interaction lock precedes confirm IPC and handles ${outcome}`, async () => {
    const gate = new QuitInteractionGate();
    let finish!: () => void;
    let fail!: () => void;
    let confirmed = 0;
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = () => reject(new Error("synthetic failure"));
    });
    const owner = new QuitRequest(
      async () => () => {},
      () => {
        assert.equal(gate.allowed(), false, "Even retained callbacks see lock");
        confirmed += 1;
        if (outcome === "throw")
          throw new Error("synthetic synchronous failure");
        return pending;
      },
      (action) => action(),
      () => {},
      gate.lock,
    );
    owner.start();
    owner.requestQuit();
    assert.equal(confirmed, 1);
    if (outcome === "success") finish();
    if (outcome === "failure") fail();
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    assert.equal(gate.allowed(), outcome !== "success");
    owner.dispose();
    assert.equal(gate.allowed(), true);
  });
}
