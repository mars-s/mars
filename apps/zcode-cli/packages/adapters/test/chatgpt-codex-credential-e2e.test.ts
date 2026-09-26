/**
 * End to end proof, with no network, that a request-scoped ChatGPT credential
 * reaches the wire on the same request that carries `store: false`.
 *
 * This goes through the real `@ai-sdk/openai` responses factory, because the two
 * requirements interact inside the SDK: the account id travels as a provider
 * header while the bearer token is built by the SDK from the request-scoped key.
 * Asserting on the transport rather than on an intermediate config is the only
 * way to show that both actually left the process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import type { ModelRequestAuth } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const PROVIDER_CONFIG: RegistryProviderConfig = {
  access: { type: "oauth", apiKey: "" },
  api: { type: "openai-responses", baseUrl: CODEX_BASE_URL },
  group: "standard-personal",
  logo: { type: "builtin", key: "openai" },
} as RegistryProviderConfig;

const REQUEST_AUTH: ModelRequestAuth = {
  apiKey: "fake-tok-1",
  headers: { "ChatGPT-Account-Id": "fake-account-id", originator: "zcode" },
};

/** The option values the runner binds for every attempt. */
const OPTION_SPECS = {
  maxOutputTokens: { map: "{'max_output_tokens': maxOutputTokens}" },
  reasoningLevel: { map: "{\"reasoning\": {\"effort\": reasoningLevel}}" },
};
const OPTIONS = { maxOutputTokens: 4096, reasoningLevel: "enabled" };

interface Captured {
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/** Answers with a minimal valid Responses payload and records the request. */
function capturingTransport() {
  const captured: Captured[] = [];
  const transport = (async (_input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers)) {
      headers[name] = value;
    }
    captured.push({
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      headers,
    });
    return new Response(
      JSON.stringify({
        created_at: 1_800_000_000,
        id: "resp_fake",
        output: [
          { content: [{ text: "ok", type: "output_text" }], id: "msg_fake", role: "assistant", type: "message" },
        ],
        output_text: "ok",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { captured, transport };
}

test("a request-scoped credential reaches the wire together with store:false", async () => {
  const { captured, transport } = capturingTransport();
  const execution = new AiSdkModelExecution({}, { transport });
  const bound = execution.bindModel({
    modelId: "gpt-5.6-luna",
    optionSpecs: OPTION_SPECS,
    providerConfig: PROVIDER_CONFIG,
    providerId: "account:chatgpt",
    supportsJsonSchemaOutput: false,
  });

  const resolved = bound.resolveRequest({
    options: OPTIONS,
    requestAuth: REQUEST_AUTH,
  });
  await generateText({ model: resolved.model, prompt: "hi" });

  assert.equal(captured.length, 1);
  const attempt = captured[0]!;
  assert.equal(attempt.headers["chatgpt-account-id"], "fake-account-id");
  assert.equal(attempt.headers.originator, "zcode");
  assert.equal(attempt.headers.authorization, "Bearer fake-tok-1");
  assert.equal(attempt.body.store, false, "the Codex backend rejects a body without it");
  assert.equal(attempt.body.model, "gpt-5.6-luna");
});

test("without a request credential the request never leaves the process", async () => {
  // This is why a dynamic credential must not be frozen into the bind-time
  // snapshot: the template ships no static key, so the SDK refuses to build a
  // request at all. This is a fail-closed outcome, not a credential leak.
  const { captured, transport } = capturingTransport();
  const execution = new AiSdkModelExecution({}, { transport });
  const bound = execution.bindModel({
    modelId: "gpt-5.6-luna",
    optionSpecs: OPTION_SPECS,
    providerConfig: PROVIDER_CONFIG,
    providerId: "account:chatgpt",
    supportsJsonSchemaOutput: false,
  });

  const resolved = bound.resolveRequest({ options: OPTIONS });
  await assert.rejects(() => generateText({ model: resolved.model, prompt: "hi" }));
  assert.equal(captured.length, 0, "no anonymous request is sent");
});

test("a non-Codex provider at the same api type is untouched", async () => {
  const { captured, transport } = capturingTransport();
  const execution = new AiSdkModelExecution({}, { transport });
  const bound = execution.bindModel({
    modelId: "gpt-5.6-luna",
    optionSpecs: OPTION_SPECS,
    providerConfig: {
      ...PROVIDER_CONFIG,
      access: { apiKey: "sk-fake", type: "apiKey" },
      api: { baseUrl: "https://api.openai.com/v1", type: "openai-responses" },
    } as RegistryProviderConfig,
    providerId: "openai",
    supportsJsonSchemaOutput: false,
  });

  const resolved = bound.resolveRequest({ options: OPTIONS });
  await generateText({ model: resolved.model, prompt: "hi" });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.body.store, undefined, "store is a Codex requirement, not a general one");
  assert.equal(captured[0]!.headers.authorization, "Bearer sk-fake");
});
