/**
 * The end-to-end proof that the host-verified destination is the used destination.
 *
 * The hazard this covers is a TOCTOU between two independently snapshotted copies
 * of one provider config. The host verifies the provider identity against a LIVE
 * registry view, read fresh per request, and only then releases the live ChatGPT
 * bearer. The agent FREEZES the provider config when the model is bound and
 * builds every later request URL from that frozen base URL. An actor able to
 * rewrite the user's `provider_config.json` can therefore:
 *
 *   1. bind a model for a provider whose base URL is an attacker host, and
 *   2. rewrite the config so that provider's live base URL is the real Codex
 *      endpoint,
 *
 * after which the host's live view passes all four checks, releases the token,
 * and the agent would send it to the attacker.
 *
 * So these tests go through the REAL production path: the real
 * `AiSdkModelExecution.bindModel` that freezes the config, the real
 * `composeRequestAuthRefresh` the runner installs, the real
 * `resolveModelForAttempt` that hands the credential to the SDK, and the real
 * `@ai-sdk/openai` responses factory. Only the transport and the host are fakes,
 * and the assertion is on the transport: a mismatch must send zero bytes, not
 * merely fail somewhere upstream.
 *
 * No real token, key, account or endpoint appears in this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import { ModelErrorCode, ModelProtocolError, type ModelRequestAuth } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { composeRequestAuthRefresh } from "../src/model/runner-request-auth.js";
import { resolveModelForAttempt } from "../src/model/runner-runtime-headers.js";
import type { AiSdkModelTextRequest } from "../src/model/runner-runtime.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ATTACKER_BASE_URL = "https://attacker.example/backend-api/codex";
const PROVIDER_ID = "account:chatgpt";
const MODEL_ID = "gpt-5.6-luna";

const REQUEST_AUTH: ModelRequestAuth = {
  apiKey: "tok-1",
  headers: { "ChatGPT-Account-Id": "acct-fake-1", originator: "zcode" },
};

const OPTION_SPECS = {
  maxOutputTokens: { map: "{'max_output_tokens': maxOutputTokens}" },
  reasoningLevel: { map: "{\"reasoning\": {\"effort\": reasoningLevel}}" },
};
const OPTIONS = { maxOutputTokens: 4096, reasoningLevel: "enabled" };

function providerConfig(baseUrl: string): RegistryProviderConfig {
  return {
    access: { type: "oauth" },
    api: { type: "openai-responses", baseUrl },
    group: "standard-personal",
    logo: { type: "builtin", key: "openai" },
  } as RegistryProviderConfig;
}

interface Captured {
  readonly headers: Record<string, string>;
  readonly url: string;
}

/** Records every physical request and answers with a minimal Responses payload. */
function capturingTransport() {
  const captured: Captured[] = [];
  const transport = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers)) {
      headers[name] = value;
    }
    captured.push({ headers, url: String(input) });
    return new Response(
      JSON.stringify({
        created_at: 1_800_000_000,
        id: "resp_fake",
        output: [
          {
            content: [{ text: "ok", type: "output_text" }],
            id: "msg_fake",
            role: "assistant",
            type: "message",
          },
        ],
        output_text: "ok",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { captured, transport };
}

/** A host that verified `approvedBaseUrl` and released a credential for it. */
function hostThatVerified(approvedBaseUrl: string) {
  const asked: { approvedBaseUrl: string; providerId: string; modelId: string }[] = [];
  return {
    asked,
    refresh: async (params: { providerId: string; modelId: string }) => {
      asked.push({ approvedBaseUrl, modelId: params.modelId, providerId: params.providerId });
      return { approvedBaseUrl, headersApplied: true, requestAuth: REQUEST_AUTH };
    },
  };
}

/**
 * Everything the runner does between a bound model and the bytes, with only the
 * transport and the host replaced.
 */
function prepare(baseUrl: string, approvedBaseUrl: string) {
  const { captured, transport } = capturingTransport();
  const execution = new AiSdkModelExecution({}, { transport });
  // The freeze: this is the snapshot the attacker controls at bind time, and it
  // is what every later request URL is built from.
  const bound = execution.bindModel({
    modelId: MODEL_ID,
    optionSpecs: OPTION_SPECS,
    providerConfig: providerConfig(baseUrl),
    providerId: PROVIDER_ID,
    supportsJsonSchemaOutput: false,
  });
  const host = hostThatVerified(approvedBaseUrl);
  const request = {
    refreshRuntimeHeadersBeforeAttempt: composeRequestAuthRefresh({
      hostRefresh: host.refresh,
      requestBaseUrl: String(bound.resolved.baseURL),
    }),
  } as AiSdkModelTextRequest;
  return {
    captured,
    host,
    resolve: () =>
      resolveModelForAttempt({
        attempt: 1,
        request,
        resolveModel: (requestAuth) =>
          requestAuth
            ? bound.resolveRequest({ options: OPTIONS, requestAuth })
            : bound.resolved,
      }),
  };
}

test("a credential verified for this model's own destination reaches the wire", async () => {
  // The matching half. Without it the refusal above proves nothing: a gate that
  // always threw would pass the mismatch case too.
  const { captured, host, resolve } = prepare(CODEX_BASE_URL, CODEX_BASE_URL);
  const resolved = await resolve();
  await generateText({ model: resolved.model, prompt: "hi" });

  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.url.startsWith(CODEX_BASE_URL), captured[0]!.url);
  assert.equal(captured[0]!.headers.authorization, "Bearer tok-1");
  assert.equal(captured[0]!.headers["chatgpt-account-id"], "acct-fake-1");
  assert.equal(host.asked.length, 1);
});

test("a trailing slash on either side is the same destination, not a refusal", async () => {
  const { captured, resolve } = prepare(`${CODEX_BASE_URL}/`, CODEX_BASE_URL);
  const resolved = await resolve();
  await generateText({ model: resolved.model, prompt: "hi" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.headers.authorization, "Bearer tok-1");
});

test("a credential verified for another host is refused and zero bytes are sent", async () => {
  // The mismatch half, and the shape of the attack it closes: the host verified
  // the real Codex endpoint against its live registry view, while the agent's
  // frozen base URL is the attacker host the config was bound with.
  const { captured, host, resolve } = prepare(ATTACKER_BASE_URL, CODEX_BASE_URL);

  await assert.rejects(
    () => resolve(),
    (error: unknown) => {
      assert.ok(error instanceof ModelProtocolError, String(error));
      assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
      assert.equal(error.context?.detail, "approved-base-url-mismatch");
      return true;
    },
  );
  assert.equal(captured.length, 0, "the request must not be built, let alone sent");
  assert.equal(host.asked.length, 1, "the host was asked; its answer is what was refused");
});

test("a host that names no destination cannot release a credential into a request", async () => {
  // The attestation is what makes the check possible, so a host that omits it
  // must not get a pass. The protocol schema requires the field, so this is the
  // shape a malformed or unexpected host answer degrades to.
  const { captured, resolve } = prepare(CODEX_BASE_URL, undefined as unknown as string);
  await assert.rejects(() => resolve(), /different destination/u);
  assert.equal(captured.length, 0);
});

test("a host prefix in the approved URL is not the same destination", async () => {
  // The normalizer is what makes the comparison sound, so it is asserted
  // directly here: none of these may compare equal to the real Codex endpoint,
  // even though each of them contains it as a substring.
  for (const approved of [
    `${CODEX_BASE_URL}.attacker.example`,
    `${CODEX_BASE_URL}@attacker.example`,
    "https://evil.example/https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api",
  ]) {
    const { captured, resolve } = prepare(CODEX_BASE_URL, approved);
    await assert.rejects(
      () => resolve(),
      /different destination/u,
      `${approved} must not equal ${CODEX_BASE_URL}`,
    );
    assert.equal(captured.length, 0, approved);
  }
});
