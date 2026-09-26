/**
 * The pending-request ledger must not grow across a long lived desktop session.
 *
 * `pendingProviderRuntimeHeaders` exists so an explicit cancel or a client
 * disposal can find a credential resolution that is still in flight. Every
 * physical model request puts one entry in, so the only thing keeping that map
 * from accumulating one entry per request for the life of the process is the
 * removal on the completion path. That call site is three thousand lines deep in
 * the agent service, so the rule it depends on lives in `settledRequestLedger.ts`
 * and is proven here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetSettledRequest } from "../src/zcode-agent/settledRequestLedger.js";

interface Entry {
  readonly requestId: string;
}

function entry(requestId: string): Entry {
  return { requestId };
}

test("an answered request leaves the ledger on success, on refusal and on failure", async () => {
  // The removal runs on the completion path, not on the success path, so a
  // refusal and a throw are the two outcomes that would leak if it were wired to
  // the success branch instead. Each one is driven through the same
  // `.finally()` shape the service uses.
  const settleAfter = async (
    outcome: "ok" | "refused" | "threw",
    run: () => Promise<unknown>,
  ): Promise<number> => {
    const pending = new Map<string, Entry>();
    const request = entry("req-1");
    pending.set("req-1", request);
    try {
      await run().finally(() => {
        forgetSettledRequest(pending, "req-1", request);
      });
    } catch {
      if (outcome !== "threw") {
        throw new Error(`unexpected rejection for ${outcome}`);
      }
    }
    return pending.size;
  };

  assert.equal(await settleAfter("ok", () => Promise.resolve("credential")), 0);
  assert.equal(await settleAfter("refused", () => Promise.resolve("refused")), 0);
  assert.equal(
    await settleAfter("threw", () => Promise.reject(new Error("boom"))),
    0,
    "a rejected resolution must not leave the request pending forever",
  );
});

test("a whole session's worth of requests leaves nothing behind", async () => {
  // The actual growth property: register and settle N times, the size returns to
  // zero rather than creeping up by one per physical request.
  const pending = new Map<string, Entry>();
  for (let index = 0; index < 500; index += 1) {
    const key = `req-${index}`;
    const request = entry(key);
    pending.set(key, request);
    await Promise.resolve();
    forgetSettledRequest(pending, key, request);
    assert.equal(pending.size, 0, `after request ${index}`);
  }
});

test("a late completion cannot evict a newer request that reused the key", () => {
  // The agent re-sends a business requestId to recover a lost protocol id. A
  // slow completion of the first attempt must not delete the entry that is now
  // answering the caller's wait, so the removal is compare-then-delete.
  const pending = new Map<string, Entry>();
  const first = entry("same-key");
  pending.set("same-key", first);
  const second = entry("same-key");
  pending.set("same-key", second);

  forgetSettledRequest(pending, "same-key", first);
  assert.equal(pending.get("same-key"), second, "the newer pending request survives");

  forgetSettledRequest(pending, "same-key", second);
  assert.equal(pending.size, 0);
});

test("settling a key that was already cancelled is a no-op", () => {
  // The explicit cancel and the client disposal removals stay in place, so a
  // completion arriving after either of them must not throw or resurrect.
  const pending = new Map<string, Entry>();
  const request = entry("req-1");
  pending.set("req-1", request);
  pending.delete("req-1");
  forgetSettledRequest(pending, "req-1", request);
  assert.equal(pending.size, 0);
});
