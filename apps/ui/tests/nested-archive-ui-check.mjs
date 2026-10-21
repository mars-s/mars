// Side chats and sub-threads in the sidebar, against routed fixtures: an open side chat is
// listed once (not again as a sub-thread), and both kinds archive into an "N archived" toggle
// through /api/conversations/organise.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
const side = { id: 8, title: "Run progress full width", running: false };
const worker = { id: 22, conversationId: 1, title: "Audit service units", status: "running" };
const conversations = () => [{ id: 1, title: "Main Mars Chat", sideChats: [side] }];
const state = (id) => ({
  runtime: "Pi Durable 1.3.0",
  conversationId: id,
  selectedConversationId: id,
  ...(id === 8 ? { parentConversationId: 1, sideChatOf: 1, conversationTitle: side.title } : {}),
  auth: { connected: true, state: "connected", events: [] },
  providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna" }],
  extensions: [],
  conversations: conversations(),
  subthreads: [worker],
  view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state(Number(url.searchParams.get("conversationId") || 1)) });
  if (request.method() !== "POST") return route.fulfill({ json: { conversations: conversations(), rootId: 1 } });
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/conversations/organise") {
    const row = body.conversationId === "8" ? side : body.conversationId === "22" ? worker : null;
    if (row && "archived" in body) row.archived = body.archived;
    return route.fulfill({ json: { conversation: row } });
  }
  return route.fulfill({ json: { ok: true } });
});
const sidebar = page.locator(".live-sidebar");
const named = (name) => sidebar.getByRole("button", { name, exact: true });
try {
  await page.goto(uiBaseURL() + "?conversation=8", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await named(side.title).first().waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await named(side.title).count(), 1, "an open side chat is listed once, not again as a sub-thread");

  await named("Main Mars Chat").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "1");
  await named(side.title).hover();
  await sidebar.getByRole("button", { name: `Options for ${side.title}` }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await sidebar.getByRole("button", { name: "1 archived" }).first().waitFor();
  assert.deepEqual(requests.at(-1).body, { conversationId: "8", archived: true });
  assert.equal(await named(side.title).count(), 0, "the archived side chat folds away");
  await sidebar.getByRole("button", { name: "1 archived" }).first().click();
  await named(side.title).waitFor();

  await named("Audit service units Working").hover();
  await sidebar.getByRole("button", { name: "Options for Audit service units" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  assert.deepEqual(requests.at(-1).body, { conversationId: "22", archived: true });
  await page.waitForFunction(() => !document.body.innerText.includes("Audit service units") || document.querySelectorAll(".live-nested-archived").length === 2);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["open side chat listed once", "archive side chat", "archived toggle", "archive sub-thread"] }));
} finally {
  await browser.close();
}
