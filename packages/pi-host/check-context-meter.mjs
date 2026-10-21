import assert from "node:assert/strict";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { contextMeter } from "./context-meter.mjs";

const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const system = { role: "system", content: "You are Mars. ".repeat(40), timestamp: 1 };
const user = { role: "user", content: "Check the deploy script", timestamp: 2 };
const assistant = { role: "assistant", content: [{ type: "text", text: "Reading it" }], api: "fake", provider: "fake", model: "m", usage: usage(9000, 400), stopReason: "toolUse", timestamp: 3 };
const tool = { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "x".repeat(4000) }], isError: false, timestamp: 4 };
const followUp = { role: "user", content: "Now fix it please", timestamp: 5 };
const view = (messages, head) => ({
  head,
  entries: messages.map((_, index) => ({ id: index + 1 })),
  contributions: messages.map((message) => [message]),
  messages,
});
const model = { contextWindow: 200000 };

const unknown = contextMeter(view([system, user]), undefined);
assert.deepEqual(unknown, { basis: "unavailable" }, "no model means no invented window");
assert.deepEqual(contextMeter(view([]), { contextWindow: 0 }), { basis: "unavailable" });

const fresh = contextMeter(view([system, user]), model);
assert.equal(fresh.basis, "estimated", "no provider usage yet");
assert.equal(fresh.used, estimateMessageTokens(system) + estimateMessageTokens(user));

const measured = contextMeter(view([system, user, assistant, tool, followUp]), model);
assert.equal(measured.basis, "reported");
assert.equal(
  measured.used,
  calculateContextTokens(assistant.usage) + estimateMessageTokens(tool) + estimateMessageTokens(followUp),
  "matches Pi Durable estimateContext: newest usage plus trailing estimates",
);
assert.equal(
  measured.segments.reduce((sum, segment) => sum + segment.tokens, 0),
  measured.used,
  "categories partition the measured total exactly",
);
assert.ok(measured.segments.some((segment) => segment.id === "tools"));
assert.equal(measured.limit, 200000);
assert.ok(Math.abs(measured.compactAt - (200000 - 16384) / 200000) < 1e-9, "threshold follows the compaction reserve");

const compacted = contextMeter(view([system, user, assistant, tool, followUp], { id: 3 }), model);
assert.equal(compacted.basis, "estimated", "usage before the head marker does not count");

console.log("PASS context meter: unavailable without a window, Pi Durable total, exact category partition, compaction threshold");
