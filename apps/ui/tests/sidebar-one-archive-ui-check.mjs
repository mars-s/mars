// One Archived list (docs/LIVE-INTEGRATION.md "Archive"), against routed fixtures: under a chat
// only running side chats and working sub-threads; finished ones, archived chats and the host's
// older rows sit in one Archived list at the bottom, newest first; hovering one names the chat
// it came from. A side chat that finishes, or a chat archived from its menu, lands on top at once. No
// per-chat "archived", "finished" or "older" lines.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const sides = [
  { id: "8", title: "Busy side chat", running: true },
  { id: "9", title: "Finished side chat", running: false },
];
const workers = [
  { id: "22", conversationId: "1", title: "Working sub-thread", status: "running" },
  { id: "23", conversationId: "1", title: "Bug hunt: lanes", status: "completed" },
];
const chats = [
  { id: "1", title: "Main Mars Chat", sideChats: sides },
  { id: "2", title: "Release notes", sideChats: [] },
  { id: "3", title: "Long archived chat", sideChats: [], archived: true },
];
const hostArchive = () => ({
  items: [
    { id: "23", title: "Bug hunt: lanes", kind: "task", parentId: "1", parentTitle: "Main Mars Chat" },
    { id: "9", title: "Finished side chat", kind: "side", parentId: "1", parentTitle: "Main Mars Chat" },
    ...Array.from({ length: 56 }, (_, i) => ({ id: String(100 + i), title: "Old side chat " + (i + 1), kind: "side", parentId: "1", parentTitle: "Main Mars Chat" })),
    { id: "3", title: "Long archived chat", kind: "chat", parentId: "", parentTitle: "" },
  ],
  total: 59,
});
const archiveCalls = [];
const state = (id) => ({
  runtime: "Pi Durable 1.3.0", conversationId: id, selectedConversationId: id,
  ...(id === "9" ? { parentConversationId: "1", sideChatOf: "1", conversationTitle: "Finished side chat" } : {}),
  auth: { connected: true, state: "connected", events: [] }, providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [],
  conversations: chats, subthreads: workers,
  view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state(url.searchParams.get("conversationId") || "1") });
  if (url.pathname === "/api/conversations/archive") {
    archiveCalls.push(url.search);
    const all = hostArchive();
    const offset = Number(url.searchParams.get("offset")) || 0;
    const limit = Number(url.searchParams.get("limit")) || 50;
    return route.fulfill({ json: { items: all.items.slice(offset, offset + limit), total: all.total } });
  }
  if (url.pathname === "/api/conversations/organise") {
    const body = request.postDataJSON();
    const row = chats.find((chat) => chat.id === body.conversationId);
    if (row && "archived" in body) row.archived = body.archived;
    return route.fulfill({ json: { conversation: row } });
  }
  return route.fulfill({ json: { conversations: chats, rootId: "1" } });
});
const sidebar = page.locator(".live-sidebar");
const named = (name) => sidebar.getByRole("button", { name, exact: true });
const archiveRows = () => sidebar.locator(".live-archived .live-group-rows .live-nav-label").allInnerTexts();
const firstArchived = (title) =>
  page.waitForFunction((title) => document.querySelector(".live-archived .live-group-rows .live-nav-label")?.textContent === title, title, { timeout: 5000 });
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const under = sidebar.locator(".live-side-chats");
  await under.getByText("Busy side chat", { exact: true }).waitFor();
  await under.getByText("Working sub-thread", { exact: true }).waitFor();
  const toggle = sidebar.getByRole("button", { name: /^Archived/ });
  await toggle.waitFor();
  await page.waitForFunction(() => /Archived\s*59/.test(document.querySelector(".live-archived .live-group-toggle")?.textContent ?? ""));
  assert.equal(await sidebar.locator(".live-side-chats").getByText("Finished side chat").count(), 0, "a finished side chat is not under its parent");
  assert.equal(await sidebar.locator(".live-side-chats").getByText("Bug hunt: lanes").count(), 0, "nor a finished sub-thread");
  assert.doesNotMatch(await sidebar.innerText(), /\d+ archived|Archive \d+ finished|older side chat/i, "no other archive lines");
  checks.push("only working rows under the chat, one Archived line");

  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await sidebar.getByText("Old side chat 1", { exact: true }).waitFor();
  const rows = await archiveRows();
  assert.deepEqual(rows.slice(0, 3), ["Bug hunt: lanes", "Finished side chat", "Old side chat 1"], "host order, newest first");
  assert.equal(await sidebar.locator(".live-archived .live-archive-row button").first().getAttribute("title"), "Bug hunt: lanes, from Main Mars Chat", "hovering names the chat it came from");
  await sidebar.getByRole("button", { name: "Show 9 more" }).click();
  await sidebar.getByText("Old side chat 56", { exact: true }).waitFor();
  assert.equal((await archiveRows()).at(-1), "Long archived chat", "an archived chat already known on load keeps its place, last");
  assert.equal(await sidebar.getByRole("button", { name: /Show \d+ more/ }).count(), 0);
  checks.push("newest first, from the host, paged");

  sides[0].running = false;
  await firstArchived("Busy side chat");
  assert.equal(await sidebar.locator(".live-side-chats").getByText("Busy side chat").count(), 0, "it left its parent");
  checks.push("a side chat that finishes lands on top");

  await named("Release notes").hover();
  await sidebar.getByRole("button", { name: "Options for Release notes" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await firstArchived("Release notes");
  checks.push("an archived chat lands on top");

  await sidebar.locator(".live-archived").getByRole("button", { name: /^Finished side chat/ }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "9");
  await sidebar.locator(".live-side-chats").getByText("Finished side chat").waitFor();
  checks.push("an archived side chat opens under its parent");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, archiveCalls: archiveCalls.slice(0, 5), error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
