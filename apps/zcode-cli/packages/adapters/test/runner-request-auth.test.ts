/**
 * The composed port is the only place `ModelRequestAuthSource.resolve` is
 * reached, so these tests pin the two properties that matter: the host wins when
 * it is there, and a declared dependency with nothing behind it fails closed
 * instead of going out anonymous.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode, ModelProtocolError, type ModelRequestAuth } from "@zcode/contracts";
import { composeRequestAuthRefresh } from "../src/model/runner-request-auth.js";

const PARAMS = { attempt: 1, providerId: "account:chatgpt", modelId: "gpt-5.6-luna" };

test("a host refusal is final and is never retried against the scoped source", async () => {
  let sourceCalls = 0;
  const refresh = composeRequestAuthRefresh({
    hostRefresh: async () => ({ headersApplied: false }),
    source: {
      resolve: async () => {
        sourceCalls += 1;
        return { apiKey: "unused-tok" };
      },
    },
  });

  assert.deepEqual(await refresh(PARAMS), { headersApplied: false });
  assert.equal(sourceCalls, 0, "the host is the authority, a refusal is not a fallback trigger");
});

test("a host credential is returned verbatim, headers and api key", async () => {
  const requestAuth: ModelRequestAuth = {
    apiKey: "host-token",
    headers: { "ChatGPT-Account-Id": "fake-account", originator: "zcode" },
  };
  const refresh = composeRequestAuthRefresh({
    hostRefresh: async () => ({ headersApplied: true, requestAuth }),
  });
  const result = await refresh(PARAMS);
  assert.equal(result.headersApplied, true);
  assert.deepEqual(result.requestAuth, requestAuth);
});

test("the 401 reason reaches the host unchanged", async () => {
  const reasons: (string | undefined)[] = [];
  const refresh = composeRequestAuthRefresh({
    hostRefresh: async (input) => {
      reasons.push(input.reason);
      return { headersApplied: true, requestAuth: { apiKey: "rotated" } };
    },
  });

  await refresh({ ...PARAMS, attempt: 2, reason: "unauthorized" });
  await refresh(PARAMS);
  assert.deepEqual(reasons, ["unauthorized", undefined], "a plain refresh has no reason");
});

test("without a host the scoped source is resolved per attempt", async () => {
  const seen: unknown[] = [];
  const refresh = composeRequestAuthRefresh({
    source: {
      resolve: async (input) => {
        seen.push(input);
        return { apiKey: `token-${input.attempt}` };
      },
    },
  });

  const first = await refresh(PARAMS);
  const second = await refresh({ ...PARAMS, attempt: 2 });
  assert.equal(first.requestAuth?.apiKey, "token-1");
  assert.equal(second.requestAuth?.apiKey, "token-2", "the credential is re-resolved, not frozen");
  assert.equal(seen.length, 2);
});

test("a declared dependency with no source at all fails closed", async () => {
  const refresh = composeRequestAuthRefresh({});
  await assert.rejects(
    () => refresh(PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof ModelProtocolError);
      assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
      return true;
    },
  );
});

test("a source that produces no credential fails closed", async () => {
  const refresh = composeRequestAuthRefresh({ source: { resolve: async () => undefined } });
  await assert.rejects(
    () => refresh(PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof ModelProtocolError);
      assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
      return true;
    },
  );
});

test("a source that throws is surfaced rather than downgraded to anonymous", async () => {
  const refresh = composeRequestAuthRefresh({
    source: {
      resolve: async () => {
        throw new Error("grant store is locked by another process");
      },
    },
  });
  await assert.rejects(() => refresh(PARAMS), /grant store is locked/);
});
