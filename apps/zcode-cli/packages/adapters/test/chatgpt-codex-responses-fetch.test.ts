/**
 * The Codex responses wrapper is the only place `store: false` and the 401
 * rotate-and-replay exist, so both are proven here against a fake transport and
 * a fake host. No real token, key or endpoint appears in this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runWithModelInvocationContext, type ModelRequestAuth } from "@zcode/contracts";
import {
  createChatGptCodexResponsesFetch,
  isChatGptCodexBackend,
} from "../src/model/chatgpt-codex-responses-fetch.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const IDENTITY = { modelId: "gpt-5.6-luna", providerId: "account:chatgpt" };

interface Attempt {
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** A transport that records every attempt and answers with the queued statuses. */
function fakeTransport(statuses: readonly number[]) {
  const attempts: Attempt[] = [];
  let index = 0;
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers)) {
      headers[name] = value;
    }
    attempts.push({
      body:
        typeof init?.body === "string" && headers["content-type"]?.includes("json")
          ? JSON.parse(init.body)
          : init?.body,
      headers,
    });
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return new Response(JSON.stringify({ id: `resp_${index}` }), {
      headers: { "content-type": "application/json" },
      status,
    });
  };
  return { attempts, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

/** A host that answers the rotation request, recording what it was asked. */
function fakeHost(requestAuth: ModelRequestAuth | undefined) {
  const calls: { attempt: number; reason?: string; providerId: string; modelId: string }[] = [];
  return {
    calls,
    context: {
      refreshRuntimeHeadersBeforeAttempt: async (input: {
        attempt: number;
        reason?: "model-request" | "unauthorized";
        providerId: string;
        modelId: string;
      }) => {
        calls.push(input);
        return requestAuth ? { headersApplied: true, requestAuth } : { headersApplied: false };
      },
    },
  };
}

function jsonRequest(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
    method: "POST",
  };
}

test("activation keys off the resolved registry facts only", () => {
  assert.equal(isChatGptCodexBackend({ accessType: "oauth", baseUrl: CODEX_BASE_URL }), true);
  assert.equal(
    isChatGptCodexBackend({ accessType: "oauth", baseUrl: `${CODEX_BASE_URL}/` }),
    true,
    "a trailing slash is the same endpoint",
  );
  // A personal provider may name the shipped template, so the template name is
  // never an input. These are the two ways the request could be aimed elsewhere.
  assert.equal(
    isChatGptCodexBackend({ accessType: "oauth", baseUrl: "https://attacker.example/v1" }),
    false,
  );
  assert.equal(
    isChatGptCodexBackend({ accessType: "apiKey", baseUrl: CODEX_BASE_URL }),
    false,
    "a static key at the Codex host is not the subscription flow",
  );
  assert.equal(isChatGptCodexBackend({ accessType: null, baseUrl: null }), false);
});

test("the outgoing body carries store:false", async () => {
  const transport = fakeTransport([200]);
  const host = fakeHost(undefined);
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);

  const init = jsonRequest({ input: "hi", model: "gpt-5.6-luna" });
  await runWithModelInvocationContext(host.context, () =>
    wrapped(`${CODEX_BASE_URL}/responses`, init),
  );

  assert.equal(transport.attempts.length, 1, "a 200 is not retried");
  const attempt = transport.attempts[0]!;
  assert.equal((attempt.body as Record<string, unknown>).store, false);
  // The rest of the SDK body is untouched, this is a rewrite and not a rebuild.
  assert.equal((attempt.body as Record<string, unknown>).model, "gpt-5.6-luna");
  assert.equal((attempt.body as Record<string, unknown>).input, "hi");
  assert.equal(host.calls.length, 0, "no rotation on the happy path");
});

test("a body that already sets store:false is left alone", async () => {
  const transport = fakeTransport([200]);
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);
  const init = jsonRequest({ model: "gpt-5.6-luna", store: false });
  await wrapped(`${CODEX_BASE_URL}/responses`, init);
  assert.equal((transport.attempts[0]!.body as Record<string, unknown>).store, false);
});

test("a non-JSON body is passed through untouched", async () => {
  const transport = fakeTransport([200]);
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);
  await wrapped(`${CODEX_BASE_URL}/responses`, { body: "raw-stream" });
  assert.equal(transport.attempts[0]!.body, "raw-stream");
});

test("a 401 rotates the credential and replays the request exactly once", async () => {
  const transport = fakeTransport([401, 200]);
  const host = fakeHost({
    apiKey: "rot-tok-2",
    headers: { "ChatGPT-Account-Id": "fake-account" },
  });
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);

  const response = await runWithModelInvocationContext(host.context, () =>
    wrapped(
      `${CODEX_BASE_URL}/responses`,
      jsonRequest(
        { model: "gpt-5.6-luna" },
        { authorization: "Bearer rej-tok-3" },
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(transport.attempts.length, 2);
  // The first attempt carried the rejected token, the second the rotated one.
  assert.equal(transport.attempts[0]!.headers.authorization, "Bearer rej-tok-3");
  assert.equal(transport.attempts[1]!.headers.authorization, "Bearer rot-tok-2");
  assert.equal(transport.attempts[1]!.headers["chatgpt-account-id"], "fake-account");
  assert.equal(
    (transport.attempts[1]!.body as Record<string, unknown>).store,
    false,
    "the replay is rewritten too",
  );
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0]!.reason, "unauthorized", "the host must rotate, not re-read");
  assert.equal(host.calls[0]!.providerId, IDENTITY.providerId);
  assert.equal(host.calls[0]!.modelId, IDENTITY.modelId);
});

test("a second 401 is surfaced instead of retried again", async () => {
  const transport = fakeTransport([401, 401]);
  const host = fakeHost({ apiKey: "rot-tok-2" });
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);

  const response = await runWithModelInvocationContext(host.context, () =>
    wrapped(`${CODEX_BASE_URL}/responses`, jsonRequest({ model: "gpt-5.6-luna" })),
  );

  assert.equal(response.status, 401);
  assert.equal(transport.attempts.length, 2, "one replay, no more");
  assert.equal(host.calls.length, 1);
});

test("a host refusal surfaces the original 401 unchanged", async () => {
  const transport = fakeTransport([401, 200]);
  const host = fakeHost(undefined);
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);

  const response = await runWithModelInvocationContext(host.context, () =>
    wrapped(`${CODEX_BASE_URL}/responses`, jsonRequest({ model: "gpt-5.6-luna" })),
  );

  assert.equal(response.status, 401);
  assert.equal(transport.attempts.length, 1, "nothing to replay with");
  assert.equal(host.calls.length, 1);
});

test("with no host on the other end the 401 reaches the caller", async () => {
  const transport = fakeTransport([401, 200]);
  const wrapped = createChatGptCodexResponsesFetch(transport.fetchImpl, IDENTITY);
  const response = await wrapped(`${CODEX_BASE_URL}/responses`, jsonRequest({ model: "m" }));
  assert.equal(response.status, 401);
  assert.equal(transport.attempts.length, 1);
});
