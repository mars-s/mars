// Sub-threads and side chats under a chat, against routed fixtures: "Archive N finished"
// archives every finished one in a click (not running ones), and "Show N older side chats"
// loads the side chats beyond the host's first page (GET /api/conversations/side-chats).
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const archived = new Set();
const sides = [
  { id: "31", title: "Research names", running: false },
  { id: "32", title: "Draft release notes", running: false },
  { id: "33", title: "Still going", running: true },
];
const workers = [
  { id: "41", conversationId: 1, title: "Bug hunt: lanes", status: "completed" },
  { id: "42", conversationId: 1, title: "Bug hunt: voice", status: "completed" },
  { id: "43", conversationId: 1, title: "Bug hunt: running", status: "running" },
];
const older = Array.from({ length: 4 }, (_, i) => ({ id: String(50 + i), title: "Older side chat " + (i + 1), running: false, ...(i === 3 ? { archived: true } : {}) }));
const posts = [];
const flag = (row) => ({ ...row, ...(archived.has(row.id) ? { archived: true } : {}) });
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/conversations/side-chats") {
    posts.push({ path: url.pathname, offset: url.searchParams.get("offset") });
    return route.fulfill({ json: { items: older, total: 7 } });
  }
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    posts.push({ path: url.pathname, body });
    if (url.pathname === "/api/conversations/organise" && body.archived) archived.add(body.conversationId);
    return route.fulfill({ json: { conversation: { id: body.conversationId } } });
  }
  return route.fulfill({ json: {
    runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
    auth: { connected: true, state: "connected", events: [] }, providerReady: true,
    models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], rootId: 1,
    conversations: [{ id: 1, title: "Main Mars Chat", sideChats: sides.map(flag), sideChatTotal: 7 }],
    subthreads: workers.map(flag),
    view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
  } });
});
const sidebar = page.locator(".live-sidebar");
// The button hides once fewer than two finished rows are left, before the last archive is sent, so wait for the posts.
const until = async (check) => { for (let n = 0; n < 100 && !check(); n++) await page.waitForTimeout(50); };
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const subs = sidebar.getByRole("list", { name: "Sub-threads" });
  await subs.getByRole("button", { name: "Archive 2 finished" }).click();
  await until(() => ["41","42"].every((id) => archived.has(id)));
  assert.deepEqual([...archived].sort(), ["41", "42"], "only the finished sub-threads");
  assert.equal(await subs.getByRole("button", { name: /^Bug hunt: running/ }).count(), 1, "the running one stays");
  checks.push("archive finished sub-threads");

  const side = sidebar.getByRole("list", { name: "Side chats" });
  await side.getByRole("button", { name: "Archive 2 finished" }).click();
  await until(() => ["31","32"].every((id) => archived.has(id)));
  assert.ok(archived.has("31") && archived.has("32") && !archived.has("33"), "finished side chats only");
  checks.push("archive finished side chats");

  await side.getByRole("button", { name: "Show 4 older side chats" }).click();
  await side.getByRole("button", { name: "Older side chat 1", exact: true }).waitFor();
  assert.equal(posts.find((p) => p.path === "/api/conversations/side-chats").offset, "3");
  assert.equal(await side.getByRole("button", { name: /^Show \d+ older/ }).count(), 0, "nothing left to load");
  assert.equal(await side.getByRole("button", { name: "Older side chat 4", exact: true }).count(), 0, "an older archived one folds away");
  checks.push("older side chats load");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, posts, error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
