/**
 * The local CLIProxyAPI template must resolve to a usable, key-authenticated
 * provider, and must never be mistaken for a registry-verified ChatGPT provider.
 *
 * The second half matters more than the first. `chatgptProviderRequestAuth`
 * decides whether a request may borrow the ChatGPT OAuth grant, and it allows
 * that only when the EFFECTIVE config is the real ChatGPT Codex endpoint. This
 * template shares the `openai-responses` apiType and the OpenAI logo with
 * `chatgpt-subscription`, so if the guard ever loosened to templateId or apiType
 * alone, this provider would silently start receiving someone else's grant.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { setDataBaseDir } from "../src/paths.js";
import { isRegistryVerifiedChatGptProvider } from "../src/zcode-agent/chatgptProviderRequestAuth.js";

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

const TEMPLATE_ID = "cliproxy-local";
const BASE_URL = "http://127.0.0.1:8317/v1";
const MODEL_IDS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];

/**
 * Any non-empty value resolves the provider, and this test never makes a
 * request, so there is nothing here to keep secret. Kept short and obviously
 * not a credential so the gate's hardcoded-secret scan stays useful for real
 * ones instead of having to learn an exception.
 */
const PLACEHOLDER = "stub";

async function startRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cliproxy-catalog-"));
  setDataBaseDir(dir);
  const personalPath = join(dir, "personal.json");
  // What the app writes when a user creates a provider from the template.
  await writeFile(
    personalPath,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        modelConfigRules: { manualProviderModelRules: [], providerModelRules: [] },
        providerConfigRules: {
          providerRules: [
            {
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: PLACEHOLDER },
              },
              enabled: true,
              providerId: "personal-cliproxy",
              providerName: "Local Proxy (CLIProxyAPI)",
              templateId: TEMPLATE_ID,
            },
          ],
        },
      },
    }),
  );
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: BUILTIN_PATH,
    personalFilePath: personalPath,
    personalPollingIntervalMs: false,
    watch: false,
    readLegacyProviders: async () => ({}),
    onPersonalConfigRecovery: () => {},
  });
  await runtime.start();
  return {
    runtime,
    async dispose() {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the local proxy template resolves with its models selectable", async () => {
  const fixture = await startRuntime();
  try {
    const view = await fixture.runtime.modelSelection.getView();
    const candidate = view.providers.find((entry) => entry.providerId === "personal-cliproxy");
    assert.ok(candidate, "a keyed provider must enter the registry");
    assert.equal(candidate.templateId, TEMPLATE_ID);
    assert.equal(candidate.config.access?.type, "api-key");
    assert.equal(candidate.config.api?.type, "openai-responses");
    assert.equal(candidate.config.api?.baseUrl, BASE_URL);
    assert.deepEqual(
      candidate.models.map((entry) => entry.modelId),
      MODEL_IDS,
      "builtinModelIds alone must be enough to make the models selectable",
    );
    for (const model of candidate.models) {
      assert.equal(model.config.enabled, true);
      // The CLI reads these without an optional chain, so a template that
      // resolved without them would crash the first real request.
      assert.equal(typeof model.config.optionSpecs.maxOutputTokens.max, "number");
    }
  } finally {
    await fixture.dispose();
  }
});

test("the local proxy template is not a registry-verified ChatGPT provider", async () => {
  // The effective config the guard actually inspects for a provider built from
  // this template. Every field matches the shipped template except the id.
  const identity = {
    templateId: TEMPLATE_ID,
    accessType: "api-key" as const,
    apiType: "openai-responses" as const,
    baseUrl: BASE_URL,
  };
  assert.equal(
    isRegistryVerifiedChatGptProvider(identity),
    false,
    "an api-key provider on localhost must never be handed the ChatGPT grant",
  );

  // Pin the two fields that could plausibly be relaxed by a future change, so
  // this test says which one is doing the work if it ever starts failing.
  // Positive control. Without this, every assertion above is a `false` that
  // would still pass if the guard returned `false` for everything, including a
  // provider that genuinely is allowed to use the grant.
  assert.equal(
    isRegistryVerifiedChatGptProvider({
      templateId: "chatgpt-subscription",
      accessType: "oauth",
      apiType: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }),
    true,
    "the real ChatGPT endpoint must still be recognised, or these negatives are vacuous",
  );

  assert.equal(
    isRegistryVerifiedChatGptProvider({ ...identity, accessType: "oauth" }),
    false,
    "the base URL is what rejects it, not the access type alone",
  );
  assert.equal(
    isRegistryVerifiedChatGptProvider({
      ...identity,
      templateId: "chatgpt-subscription",
      accessType: "oauth",
    }),
    false,
    "naming the ChatGPT template is not enough without the real endpoint",
  );
});
