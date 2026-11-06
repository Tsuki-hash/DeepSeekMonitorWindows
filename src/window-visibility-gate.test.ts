import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowVisibilityGate } from "./window-visibility-gate.ts";

test("visibility revocation is synchronous and cannot be undone by shown", () => {
  const gate = new WindowVisibilityGate();
  assert.equal(gate.isVisible(), false);
  gate.setVisible(true);
  const owner = gate.epoch();
  let invalidations = 0;
  const unsubscribe = gate.subscribeInvalidation(() => {
    invalidations += 1;
    assert.equal(gate.isVisible(), false);
    assert.notEqual(gate.epoch(), owner);
  });
  gate.setVisible(false);
  assert.equal(invalidations, 1);
  gate.setVisible(true);
  assert.equal(gate.isVisible(), true);
  assert.notEqual(gate.epoch(), owner);
  const current = gate.epoch();
  gate.setVisible(true);
  assert.equal(gate.epoch(), current, "Repeated shown does not revoke a batch");
  unsubscribe();
  gate.setVisible(false);
  assert.equal(invalidations, 1, "A detached consumer receives no callbacks");
});
