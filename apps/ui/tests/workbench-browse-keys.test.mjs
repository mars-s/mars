import assert from "node:assert/strict";
import test from "node:test";
import { browseKeys } from "../components/workbench/browse-keys.ts";

// A fake host: each mint returns the next key, revokes are recorded.
function host() {
  let next = 0;
  const minted = [];
  const revoked = [];
  const keys = browseKeys(
    async (port) => {
      const key = `key-${port}-${++next}`;
      minted.push(key);
      return key;
    },
    (key) => revoked.push(key),
  );
  return { keys, minted, revoked };
}

test("a held key is reused for its port until the pane asks for a fresh one", async () => {
  const { keys, minted } = host();
  assert.equal(keys.held(3000), undefined);
  const first = await keys.fresh(3000);
  assert.equal(keys.held(3000), first, "Back and Forward reuse the held key");
  assert.equal(keys.held(4000), undefined, "keys are per port");
  assert.deepEqual(minted, [first]);
});

test("Reload drops a key the host may have expired, revokes it and mints a new one", async () => {
  const { keys, revoked } = host();
  const stale = await keys.fresh(3000);
  keys.drop(3000);
  assert.equal(keys.held(3000), undefined, "the dropped key is never reused");
  assert.deepEqual(revoked, [stale], "the host forgets it too");
  const renewed = await keys.fresh(3000);
  assert.notEqual(renewed, stale);
  assert.equal(keys.held(3000), renewed);
});

test("a key replaced by a racing mint is revoked, not leaked", async () => {
  const { keys, revoked } = host();
  const [a, b] = await Promise.all([keys.fresh(3000), keys.fresh(3000)]);
  assert.equal(keys.held(3000), b);
  assert.deepEqual(revoked, [a]);
});

test("closing the tab revokes every held key once", async () => {
  const { keys, revoked } = host();
  const a = await keys.fresh(3000);
  const b = await keys.fresh(5173);
  keys.revokeAll();
  keys.revokeAll();
  assert.deepEqual(revoked.sort(), [a, b].sort());
  assert.equal(keys.held(3000), undefined);
});
