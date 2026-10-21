// The acceptance flow on the real host (docs/GATEWAY.md "Acceptance" 1 to 4): a fake
// Telegram, the real server.mjs with the staging-only echo model, the web chat route, and a
// real process restart. No provider or platform is called.
import assert from "node:assert/strict";
import { fakeTelegram } from "./gateway/fakes.mjs";
import { startHost } from "./workbench/test-host.mjs";

const TG_TOKEN = "123456:" + "E".repeat(30);
const OWNER = "8880001";
const telegram = await fakeTelegram({ token: TG_TOKEN });
const env = { MARS_ECHO_MODEL: "1", MARS_GATEWAY_FAKE: "1", MARS_GATEWAY_TELEGRAM: "1", MARS_TELEGRAM_TOKEN: TG_TOKEN, MARS_TELEGRAM_API: telegram.baseUrl, MARS_TELEGRAM_OWNER: OWNER };
let host = await startHost(env);
const sent = () => telegram.sent.filter((m) => String(m.chat.id) === OWNER).map((m) => m.text);
const until = async (predicate, what, ms = 10000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw Error("Timed out waiting for " + what + "\n" + host.log().slice(-1500));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const userTexts = async (id) => (await host.request(`/api/state?conversationId=${id}`)).json.view.entries
  .filter((e) => e.kind === "mars.user" || e.kind === "pi.user")
  .map((e) => { const c = e.model?.[0]?.content; return typeof c === "string" ? c : c?.find?.((p) => p.type === "text")?.text; });
try {
  // Start in Telegram.
  telegram.message({ from: OWNER, text: "Start a packing list" });
  await until(() => sent().includes("echo: Start a packing list"), "first Telegram answer");
  const row = await until(async () => (await host.request("/api/conversations")).json.conversations.find((c) => c.title === "Start a packing list"), "conversation in Recents");
  assert.equal(row.channel, "telegram");

  // Continue in the web UI through the same route the browser uses; the answer reaches Telegram too.
  const chat = await host.request("/api/chat", { method: "POST", body: { conversationId: row.id, text: "Add a torch", requestId: "web-1" } });
  assert.equal(chat.status, 202, JSON.stringify(chat.json));
  await until(() => sent().includes("echo: Add a torch"), "web message answered in Telegram");

  // Continue again from Telegram.
  telegram.message({ from: OWNER, text: "And sunscreen" });
  await until(() => sent().includes("echo: And sunscreen"), "Telegram again");
  assert.deepEqual(await userTexts(row.id), ["Start a packing list", "Add a torch", "And sunscreen"], "one conversation holds all three, in order");

  // Restart the real process; the chat stays bound, an update redelivered after the restart is ignored.
  const lastUpdate = telegram.message({ from: OWNER, text: "Before the restart" });
  await until(() => sent().includes("echo: Before the restart"), "answer before restart");
  const apiPost = await host.request("/api/gateway/api/messages", { method: "POST", body: { chatId: "script", eventId: "api-1", text: "before restart via API" } });
  assert.equal(apiPost.status, 202);
  await until(async () => (await host.request("/api/gateway/api/messages?chatId=script")).json.items.length, "API reply before restart");
  await host.stop();
  host = await startHost(env, host);
  telegram.redeliver(lastUpdate);
  telegram.message({ from: OWNER, text: "After the restart" });
  await until(() => sent().includes("echo: After the restart"), "answer after restart");
  const texts = await userTexts(row.id);
  assert.equal(texts.at(-1), "After the restart", "after a restart the chat continues the same conversation");
  assert.equal(texts.filter((t) => t === "Before the restart").length, 1, "an update redelivered after the restart is not submitted again");
  assert.equal(sent().filter((t) => t === "echo: Before the restart").length, 1, "nor answered again");
  // HTTP API replies survive the restart too: the mailbox and its numbering are in Pi.
  const status = (await host.request("/api/gateway")).json;
  const mailbox = (await host.request("/api/gateway/api/messages?chatId=script")).json;
  assert.deepEqual(mailbox.items.map((m) => m.text), ["echo: before restart via API"], "an unread API reply is still there after the restart");
  const next = await host.request("/api/gateway/api/messages", { method: "POST", body: { chatId: "script", eventId: "api-2", text: "after restart via API" } });
  assert.equal(next.status, 202);
  const later = await until(async () => { const m = (await host.request(`/api/gateway/api/messages?chatId=script&after=${mailbox.last}`)).json; return m.items.length && m; }, "API reply after restart");
  assert.equal(later.items[0].seq, mailbox.last + 1, "numbering continues, so a caller polling with after= misses nothing");
  assert.equal(status.bindings.find((b) => b.channel === "telegram")?.conversationId, row.id, "binding kept across the restart");
  assert.ok(status.audit.some((a) => a.decision === "duplicate"), "the redelivery is audited as a duplicate");
  // Crash: kill the process with SIGKILL while an answer is being written. After the restart
  // Pi resumes the run, the gateway delivers the answer once, and nothing is submitted twice.
  const slowId = telegram.message({ from: OWNER, text: "SLOW 3000 during a crash" });
  await until(async () => (await host.request("/api/gateway")).json.audit.some((a) => a.decision === "accepted" && a.eventId === String(slowId)), "slow message admitted");
  await host.crash();
  telegram.redeliver(slowId);
  host = await startHost(env, host);
  await until(() => sent().includes("echo: during a crash"), "answer delivered after a crash", 20000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(sent().filter((t) => t === "echo: during a crash").length, 1, "the answer interrupted by a crash is delivered once");
  const afterCrash = await userTexts(row.id);
  assert.equal(afterCrash.filter((t) => t === "SLOW 3000 during a crash").length, 1, "the message is in the transcript once, though Telegram redelivered it");
  console.log("PASS gateway end to end on the real host: Telegram starts a conversation, the web chat route continues it with the answer mirrored to Telegram, Telegram continues it again, and after a real restart the binding holds and a redelivered update is ignored, and unread HTTP API replies and their numbering survive the restart; after a SIGKILL mid-answer the answer is delivered once and the redelivered message is not resubmitted");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await host.stop();
  await telegram.close();
}
process.exit(process.exitCode ?? 0);
