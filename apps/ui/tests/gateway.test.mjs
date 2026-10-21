import assert from "node:assert/strict";
import test from "node:test";
import { chatLabel, parseGateway } from "../lib/pi/gateway.ts";
import { parseConversations } from "../lib/pi/live-state.ts";

test("gateway status keeps only known fields and safe states", () => {
  const parsed = parseGateway({
    adapters: [{ channel: "telegram", state: "exploded", detail: "x".repeat(900), failures: 2, token: "123:secret" }],
    bindings: [{ route: "telegram:9:dm:5", channel: "telegram", conversationId: "3", title: "Reading" }],
    pairings: [{ code: "K7QX2M9P", channel: "telegram", sender: "5", name: "sam", expiresAt: "2026-10-22T10:00:00Z" }],
    audit: Array.from({ length: 80 }, (_, i) => ({ at: "2026-10-22T09:00:00Z", channel: "telegram", decision: "accepted", text: "private " + i })),
    outbox: 4,
  });
  assert.equal(parsed.adapters[0].state, "stopped", "an unknown state reads as stopped");
  assert.equal(parsed.adapters[0].detail.length, 300, "details are bounded");
  assert.ok(!JSON.stringify(parsed).includes("secret"), "unexpected fields such as a token are dropped");
  assert.equal(parsed.audit.length, 50, "at most 50 audit rows");
  assert.ok(parsed.audit.every((row) => !("text" in row)), "audit rows never carry message text");
  assert.equal(parsed.outbox, 4);
  assert.throws(() => parseGateway({}), /unavailable/);
});

test("chat labels read as people say them", () => {
  assert.equal(chatLabel("telegram:9:dm:5550001"), "Direct message 5550001");
  assert.equal(chatLabel("discord:9:group:70:thread:71"), "Group 70, thread 71");
});

test("conversation rows carry a known channel only", () => {
  const [a, b, c] = parseConversations([{ id: "1", channel: "telegram" }, { id: "2", channel: "myspace" }, { id: "3" }]);
  assert.equal(a.channel, "telegram");
  assert.equal(b.channel, "", "an unknown channel shows no badge");
  assert.equal(c.channel, "");
});
