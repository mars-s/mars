// Opening chats from the cache (docs/LIVE-INTEGRATION.md "State caching"), against routed
// fixtures with a slow host: a chat seen before shows its messages at once when you switch back,
// with no "Connecting to Pi…"; polls send the ETag and a 304 keeps the chat as it is; after a
// reload the chat shows from IndexedDB before the host answers.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let slow = 0;
const tags = [];
const state = (id) => ({
  runtime: "Pi Durable 1.3.0", conversationId: id, selectedConversationId: id,
  auth: { connected: true, state: "connected", events: [] }, providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [],
  conversations: [{ id: 1, title: "First chat" }, { id: 2, title: "Second chat" }],
  view: { entries: [{ id: 10 + Number(id), model: [{ role: "user", content: "Message in chat " + id }] }], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") {
    const id = url.searchParams.get("conversationId") || "1";
    const tag = request.headers()["if-none-match"];
    if (tag) tags.push(tag);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (tag === '"s' + id + '"') return route.fulfill({ status: 304, headers: { etag: tag } });
    return route.fulfill({ json: state(id), headers: { etag: '"s' + id + '"' } });
  }
  return route.fulfill({ json: { conversations: [{ id: 1, title: "First chat" }, { id: 2, title: "Second chat" }], rootId: 1 } });
});
const checks = [];
const named = (name) => page.locator(".live-sidebar").getByRole("button", { name, exact: true });
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.getByText("Message in chat 1").waitFor();
  await named("Second chat").click();
  await page.getByText("Message in chat 2").waitFor();
  await page.waitForTimeout(1500);
  assert.ok(tags.includes('"s2"'), "polls send the ETag");
  assert.equal(await page.getByText("Message in chat 2").count(), 1, "a 304 keeps the chat on screen");
  checks.push("ETag polls, 304 keeps the chat");

  slow = 2500;
  await named("First chat").click();
  await page.waitForTimeout(300);
  assert.equal(await page.getByText("Message in chat 1").count(), 1, "switching back shows the chat at once");
  assert.equal(await page.getByText("Connecting to Pi…").count(), 0, "no loading line");
  checks.push("switching back is instant");

  slow = 4000;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Message in chat 1").waitFor({ timeout: 3000 });
  checks.push("after a reload the chat shows from IndexedDB first");
  slow = 0;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, tags: tags.slice(0, 6), error: String(error?.message || error).slice(0, 500) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
