import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("install_test", {}), { stopReason: "toolUse" }),
  (input) => {
    assert.match(
      JSON.stringify(input),
      /"name":"test_ping"/,
      "new registry tool offered on next request",
    );
    return fauxAssistantMessage(fauxToolCall("test_ping", {}), { stopReason: "toolUse" });
  },
  fauxAssistantMessage("Native fixture test complete"),
]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
let calls = 0;
const addition = {
  name: "test-runtime",
  tools: [
    {
      name: "test_ping",
      description: "Fixture test",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      replay: "safe",
      execute: async () => {
        calls++;
        return { output: [{ type: "text", text: "NATIVE_TOOL_OK" }] };
      },
    },
  ],
};
registry.install({
  name: "test-installer",
  tools: [
    {
      name: "install_test",
      description: "Install the fixture tool live",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        registry.install(addition);
        return { output: [{ type: "text", text: "Native extension installed" }] };
      },
    },
  ],
});
const h = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await h.root(context, {
  agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
});
const s = await root.submit({ type: "input", content: "Run the fixture" }, context);
const result = await s.wait(context);
if (result.status !== "done") console.log(JSON.stringify(result));
assert.equal(result.status, "done");
assert.equal(calls, 1);
const view = await root.viewState(context);
const plain = JSON.parse(JSON.stringify(view.value));
assert.match(JSON.stringify(plain), /NATIVE_TOOL_OK/);
console.log(
  "Real Pi Durable live extension installation, next-request tool discovery, dispatch, JSON schema, output and view-state fixture pass. Provider was explicitly faux, no account/model calls.",
);
view.dispose();
await h.close(context);
