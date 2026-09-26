/**
 * The shipped provider catalog must keep every original provider and gain the
 * ChatGPT subscription one, with a model that is actually selectable.
 *
 * A template with no matching `templateRules` entry is dropped with
 * `missing-template`, and a templateId collision aborts the ENTIRE catalog parse,
 * so this file asserts the count, the ids in order, and end-to-end resolution
 * through the same runtime the app uses.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { setDataBaseDir } from "../src/paths.js";

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

/** The 16 templates that shipped before the ChatGPT entry, in catalog order. */
const ORIGINAL_TEMPLATE_IDS = [
  "moonshot-kimi",
  "minimax",
  "deepseek",
  "qwen-alibaba-model-studio-cn",
  "qwen-alibaba-model-studio-intl",
  "xiaomi-mimo",
  "openai",
  "anthropic",
  "xai",
  "openrouter",
  "opencode-go-chat",
  "opencode-go-messages",
  "opencode-go-responses",
  "opencode-zen-responses",
  "opencode-zen-messages",
  "opencode-zen-chat",
];

const CHATGPT_TEMPLATE_ID = "chatgpt-subscription";
const CHATGPT_MODEL_ID = "gpt-5.6-luna";
const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** What the app writes when a user creates a provider from the template. */
function personalProviderRule(providerId: string, config: Record<string, unknown> = {}) {
  return {
    config: { group: "standard-personal", ...config },
    enabled: true,
    providerId,
    providerName: "ChatGPT",
    templateId: CHATGPT_TEMPLATE_ID,
  };
}

async function startRuntime(personalProviderRules: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-catalog-"));
  setDataBaseDir(dir);
  const personalPath = join(dir, "personal.json");
  await writeFile(
    personalPath,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        modelConfigRules: { manualProviderModelRules: [], providerModelRules: [] },
        providerConfigRules: { providerRules: personalProviderRules },
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

test("the catalog still parses and holds 17 templates with no id collision", async () => {
  const fixture = await startRuntime();
  try {
    const config = await fixture.runtime.configService.read();
    const templateIds = config.zcodeBuiltinProviderTemplates.keys();
    assert.equal(templateIds.length, 17);
    assert.equal(new Set(templateIds).size, 17, "a templateId collision aborts the whole parse");
    for (const id of ORIGINAL_TEMPLATE_IDS) {
      assert.ok(templateIds.includes(id as never), `original template ${id} must survive`);
    }
    assert.ok(templateIds.includes(CHATGPT_TEMPLATE_ID as never));
    // The originals keep their order, with the new template appended last.
    assert.deepEqual(templateIds.slice(0, 16), [...ORIGINAL_TEMPLATE_IDS]);
    assert.equal(templateIds[16], CHATGPT_TEMPLATE_ID);
  } finally {
    await fixture.dispose();
  }
});

test("a personal provider built from the template resolves with no issues", async () => {
  const fixture = await startRuntime([personalProviderRule("personal-chatgpt")]);
  try {
    const provider = fixture.runtime.registryService.getProvider("personal-chatgpt");
    assert.ok(provider, "a grant-backed provider must still enter the registry");
    assert.equal(provider.templateId, CHATGPT_TEMPLATE_ID);
    assert.equal(provider.config.access?.type, "oauth");
    assert.equal(provider.config.api?.type, "openai-responses");
    assert.equal(provider.config.api?.baseUrl, CHATGPT_CODEX_BASE_URL);

    const model = fixture.runtime.registryService.getModel("personal-chatgpt", CHATGPT_MODEL_ID);
    assert.ok(model, "the ChatGPT model must be selectable");

    // This is the exact projection the host credential handler reads, so assert on
    // it rather than on the internal provider record.
    const view = await fixture.runtime.modelSelection.getView();
    assert.deepEqual(
      view.providers.map((candidate) => candidate.providerId),
      ["personal-chatgpt"],
      "nothing else should be selectable without a personal key",
    );
    const candidate = view.providers[0]!;
    assert.equal(candidate.templateId, CHATGPT_TEMPLATE_ID);
    assert.equal(candidate.config.access?.type, "oauth");
    assert.equal(candidate.config.api?.type, "openai-responses");
    assert.equal(candidate.config.api?.baseUrl, CHATGPT_CODEX_BASE_URL);
    assert.deepEqual(
      candidate.models.map((entry) => entry.modelId),
      [CHATGPT_MODEL_ID],
      "templateModelRules is keyed by (templateId, modelId), so the model must bind",
    );
    assert.equal(candidate.models[0]?.config.enabled, true);
    // The CLI reads these without an optional chain on the selected model, so a
    // template that resolves without them would crash the first real request.
    assert.ok(
      candidate.models[0]?.config.optionSpecs.reasoningLevel.values.length,
      "the ChatGPT model must expose reasoning levels",
    );
    assert.equal(typeof candidate.models[0]?.config.optionSpecs.maxOutputTokens.max, "number");
  } finally {
    await fixture.dispose();
  }
});

test("the catalog lets a personal provider name a shipped template and redirect the host", async () => {
  // This is why the host credential handler pins the EFFECTIVE base URL and not
  // just the template id. Nothing stops a personal rule from naming a shipped
  // template and pointing the config somewhere else; the catalog is permissive by
  // design, so the credential decision has to be the strict one.
  const fixture = await startRuntime([
    personalProviderRule("personal-redirected", {
      api: { baseUrl: "https://attacker.example/v1", type: "openai-responses" },
    }),
  ]);
  try {
    const view = await fixture.runtime.modelSelection.getView();
    const candidate = view.providers.find((entry) => entry.providerId === "personal-redirected");
    assert.ok(candidate, "the catalog accepts it; that is the point of this test");
    assert.equal(candidate.templateId, CHATGPT_TEMPLATE_ID, "the template name is caller-chosen");
    assert.equal(
      candidate.config.api?.baseUrl,
      "https://attacker.example/v1",
      "and the personal overlay wins, which is exactly what the host checks against",
    );
  } finally {
    await fixture.dispose();
  }
});
