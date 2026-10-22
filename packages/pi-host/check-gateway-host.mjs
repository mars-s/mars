// The gateway wired into the real host (docs/GATEWAY.md): owner auth on /api/gateway, the
// HTTP API channel, a fake Telegram reaching Recents with its channel badge, pairing
// approval over HTTP, and the gateway_status tool. Temporary root, no model calls: the
// providers are not signed in, so messages are admitted and queued but never answered.
import assert from "node:assert/strict";
import { fakeTelegram } from "./gateway/fakes.mjs";
import { startHost } from "./workbench/test-host.mjs";
import { loopbackGatewayEnv } from "./gateway/host.mjs";

// A staged host only starts adapters whose API is a fake on loopback; real ones are dropped.
{
  const tg = { MARS_GATEWAY_FAKE: "1", MARS_GATEWAY_TELEGRAM: "1", MARS_TELEGRAM_TOKEN: "t", MARS_TELEGRAM_API: "http://127.0.0.1:5000" };
  assert.deepEqual(Object.keys(loopbackGatewayEnv({ ...tg, MARS_GATEWAY_DISCORD: "1", MARS_DISCORD_TOKEN: "real" })).sort(), ["MARS_GATEWAY_TELEGRAM", "MARS_TELEGRAM_API", "MARS_TELEGRAM_TOKEN"], "a real Discord is never started beside a fake Telegram");
  assert.deepEqual(loopbackGatewayEnv({ ...tg, MARS_TELEGRAM_API: "https://api.telegram.org" }), {}, "a real Telegram API is dropped");
  assert.deepEqual(loopbackGatewayEnv({ ...tg, MARS_TELEGRAM_API: "http://127.0.0.1.evil.com:5000" }), {}, "a look-alike host is dropped");
  assert.deepEqual(loopbackGatewayEnv({ ...tg, MARS_GATEWAY_FAKE: "0" }), {}, "without MARS_GATEWAY_FAKE nothing starts");
}

const TG_TOKEN = "123456:" + "B".repeat(30);
const telegram = await fakeTelegram({ token: TG_TOKEN });
const host = await startHost({
  MARS_GATEWAY_FAKE: "1", MARS_GATEWAY_TELEGRAM: "1", MARS_TELEGRAM_TOKEN: TG_TOKEN,
  MARS_TELEGRAM_API: telegram.baseUrl, MARS_TELEGRAM_OWNER: "7770001",
});
const until = async (predicate, what, ms = 8000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw Error("Timed out waiting for " + what + "\n" + host.log().slice(-1500));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  assert.equal((await host.request("/api/gateway", { auth: false })).status, 401, "owner auth required");
  const first = await host.request("/api/gateway");
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.adapters.map((a) => a.channel).sort(), ["api", "telegram"]);
  assert.ok(!JSON.stringify(first.json).includes(TG_TOKEN), "the token never appears in gateway status");
  await until(async () => (await host.request("/api/gateway")).json.adapters.find((a) => a.channel === "telegram").state === "running", "telegram running");

  // The owner's Telegram message becomes a Recents conversation with the telegram badge.
  telegram.message({ from: "7770001", text: "Hello from my phone" });
  const row = await until(async () => (await host.request("/api/conversations")).json.conversations.find((c) => c.title === "Hello from my phone"), "telegram conversation in Recents");
  assert.equal(row.channel, "telegram", "Recents rows carry the channel for the badge");
  const notReady = await until(() => telegram.sent.find((m) => String(m.chat.id) === "7770001"), "reply to the owner");
  assert.match(notReady.text, /connect the selected model provider/, "with no provider signed in, the chat is told what to do instead of a bare error");
  const state = await host.request(`/api/state?conversationId=${row.id}`);
  assert.equal(state.status, 200, "the web UI can open the Telegram conversation");

  // HTTP API channel: idempotent on eventId.
  const posted = await host.request("/api/gateway/api/messages", { method: "POST", body: { chatId: "script", eventId: "e-1", text: "From a script" } });
  assert.equal(posted.status, 202);
  assert.equal(posted.json.status, "not_ready", "no provider: admitted to the audit, not submitted");
  const again = await host.request("/api/gateway/api/messages", { method: "POST", body: { chatId: "script", eventId: "e-1", text: "From a script" } });
  assert.equal(again.json.status, "duplicate", "the same eventId is admitted once");
  assert.equal((await host.request("/api/gateway/api/messages", { method: "POST", body: { chatId: "bad id!", eventId: "e-2", text: "x" } })).status, 400);

  // A stranger gets a code; the owner approves it over HTTP.
  telegram.message({ from: "7770002", text: "hi" });
  const pending = await until(async () => (await host.request("/api/gateway")).json.pairings[0], "pairing request");
  assert.equal(pending.sender, "7770002");
  assert.equal((await host.request("/api/gateway/pairings", { method: "POST", body: { code: "WRONGCOD", approve: true } })).status, 404);
  const approved = await host.request("/api/gateway/pairings", { method: "POST", body: { code: pending.code, approve: true } });
  assert.equal(approved.status, 200);
  const after = (await host.request("/api/gateway")).json;
  assert.ok(after.allowed.telegram.includes("7770002"));
  assert.ok(["not_ready", "duplicate", "denied", "paired"].every((d) => after.audit.some((a) => a.decision === d)), "audit covers every decision");
  console.log("PASS gateway host: staging starts only loopback fake adapters, owner auth, token never in status, Telegram conversation in Recents with channel badge, web can open it, HTTP API channel idempotent on eventId, pairing approved over HTTP, audit");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await host.stop();
  await telegram.close();
}
process.exit(process.exitCode ?? 0);
