import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialDraft } from "./credential-draft.ts";

test("credential commit uses revision, not equal strings", () => {
  const draft = new CredentialDraft();
  draft.edit("SYNTHETIC_A");
  const submitted = draft.snapshot();
  draft.edit("SYNTHETIC_B");
  draft.edit("SYNTHETIC_A");
  assert.equal(draft.commit(submitted.revision), false);
  assert.equal(draft.value, "SYNTHETIC_A");
  assert.equal(draft.dirty, true);
});

test("clear advances revision and late commit cannot clear a re-entered value", () => {
  const draft = new CredentialDraft();
  draft.edit("SYNTHETIC_A");
  const submitted = draft.snapshot();
  draft.clear();
  draft.edit("SYNTHETIC_A");
  assert.equal(draft.commit(submitted.revision), false);
  assert.equal(draft.dirty, true);
  assert.equal(draft.commit(draft.revision), true);
  assert.equal(draft.value, "");
  assert.equal(draft.dirty, false);
});
