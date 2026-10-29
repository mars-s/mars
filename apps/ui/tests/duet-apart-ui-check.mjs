// Duet is not a chat (docs/DUET.md), against routed fixtures: a link to the Duet conversation
// opens Duet's own page (?view=duet), not the chat view; typing dots show from the moment the
// owner sends, before the host reports the turn; and an event turn (typing false while the
// thread runs) shows no dots.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let data = {
  threadId: "50", running: false, typing: false,
  messages: [{ id: "1", from: "duet", kind: "reply", text: "Hi, what can I do?", taskId: "", label: "", quote: "" }],
  tasks: [], board: { version: 0, facts: {}, claims: {} },
};
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/duet/thread") return route.fulfill({ json: { threadId: "50" } });
  if (url.pathname.startsWith("/api/duet")) {
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (url.pathname === "/api/duet/open") return route.fulfill({ json: { threadId: "50" } });
      if (url.pathname === "/api/duet/message") {
        data = { ...data, messages: [...data.messages, { id: String(data.messages.length + 10), from: "owner", kind: "message", text: body.text, taskId: "", label: "", quote: "" }] };
        return route.fulfill({ json: { threadId: "50", delivered: "front desk" } });
      }
    }
    return route.fulfill({ json: data });
  }
  const selected = url.searchParams.get("conversationId") || "1";
  if (url.pathname === "/api/state")
    return route.fulfill({ json: {
      duet: true, runtime: "Pi Durable 1.3.0", conversationId: selected, selectedConversationId: selected,
      auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }],
      conversationTitle: selected === "50" ? "Duet" : "Main",
      view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
    } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=50", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const duet = page.getByRole("region", { name: "Duet" });
  await duet.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => new URL(location.href).searchParams.get("view") === "duet" && new URL(location.href).searchParams.get("conversation") !== "50");
  checks.push("a link to the Duet conversation opens Duet's page");

  const input = duet.getByLabel("Message Duet");
  await input.fill("Book a table for two at 7");
  await input.press("Enter");
  await duet.getByLabel("Duet is typing").waitFor({ timeout: 5000 });
  checks.push("typing dots from the moment the owner sends");
  data = { ...data, running: true, typing: true };
  await page.waitForTimeout(1500);
  assert.equal(await duet.getByLabel("Duet is typing").count(), 1);
  data = { ...data, running: false, typing: false, messages: [...data.messages, { id: "40", from: "duet", kind: "reply", text: "Booked for 7pm.", taskId: "", label: "", quote: "" }] };
  await duet.getByText("Booked for 7pm.").waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Duet is typing"]'), null, { timeout: 5000 });
  checks.push("dots go when Duet has answered");

  // An event turn: the thread runs, but its replies are private, so no dots.
  data = { ...data, running: true, typing: false };
  await page.waitForTimeout(2500);
  assert.equal(await duet.getByLabel("Duet is typing").count(), 0, "no dots for an event turn");
  checks.push("no dots for event turns");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, url: page.url(), error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
