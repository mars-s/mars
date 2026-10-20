import assert from "node:assert/strict";
import { OAuthSessions, oauthProvider, modelSelection } from "./oauth-sessions.mjs";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const calls = [];
const sessions = new OAuthSessions({
  login: async (provider, method, interaction) => {
    calls.push([provider, method]);
    if (provider === "anthropic") {
      const choice = await interaction.prompt({
        type: "select",
        options: [{ id: "browser" }, { id: "copy_code" }],
      });
      assert.equal(choice, "copy_code");
    }
    interaction.notify({ type: "auth_url", url: "https://example.invalid/oauth" });
    const answer = await interaction.prompt({
      type: "manual_code",
      message: "Paste code",
      signal: interaction.signal,
    });
    assert.equal(answer, provider === "openai" ? "openai-answer" : "claude-answer");
  },
});
sessions.begin();
sessions.begin("anthropic");
sessions.begin("anthropic");
await tick();
assert.equal(calls.length, 2, "duplicate begin must retain the active login");
assert.equal(sessions.state("anthropic").state, "pending");
sessions.answer("anthropic", " claude-answer ");
await tick();
assert.equal(sessions.state("anthropic").state, "connected");
assert.equal(sessions.state("openai").state, "pending", "Claude answer must not complete OpenAI");
assert.throws(() => sessions.answer("anthropic", "replay"), /No active/);
sessions.answer(undefined, "openai-answer");
await tick();
assert.equal(sessions.state("openai").state, "connected");
assert.equal(oauthProvider(), "openai");
assert.throws(() => oauthProvider("untrusted"), /Unsupported/);
assert.deepEqual(modelSelection("anthropic/claude-opus-5-5"), {
  provider: "anthropic",
  modelId: "claude-opus-5-5",
});
assert.deepEqual(modelSelection("gpt-6-luna"), { provider: "openai", modelId: "gpt-6-luna" });
assert.deepEqual(modelSelection("opencode-go/claude-opus-5-5"), {
  provider: "opencode-go",
  modelId: "claude-opus-5-5",
});
const failing = new OAuthSessions({
  login: async () => {
    throw Error("private-provider-secret");
  },
});
failing.begin("anthropic");
await tick();
assert.equal(failing.state("anthropic").state, "failed");
assert.ok(!JSON.stringify(failing.state("anthropic")).includes("private-provider-secret"));
const expiring = new OAuthSessions(
  {
    login: async (_provider, _method, interaction) => {
      await interaction.prompt({ type: "manual_code", signal: interaction.signal });
    },
  },
  { timeoutMs: 10 },
);
expiring.begin("anthropic");
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(expiring.state("anthropic").state, "failed");
assert.equal(expiring.state("anthropic").prompt, null);
const native = createModels({
  credentials: { read: async () => undefined },
  authContext: { env: async () => undefined, fileExists: async () => false },
});
native.setProvider(anthropicProvider());
assert.equal(native.getModel("anthropic", "claude-opus-5-5").name, "Claude Opus 5.5");
console.log(
  "PASS native Anthropic catalogue, provider isolation, duplicate begin, compatibility, answer lifecycle, timeout and error redaction (mock OAuth, no live sign-in)",
);
