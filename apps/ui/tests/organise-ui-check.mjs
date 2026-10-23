// Filing chats and choosing effort, in the browser against routed fixtures: the row menu
// archives, groups and renames through /api/conversations/organise, sections follow the
// host's rows, Effort stays in view below a long model list, and new chats keep the effort.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/organise-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
const conversations = [
  { id: 1, title: "Main conversation" },
  { id: 2, title: "Deploy watchdog" },
  { id: 3, title: "Release notes" },
];
let thinkingLevel = "medium";
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
const models = [
  ...Array.from({ length: 24 }, (_, n) => ({ id: `anthropic/claude-${n}`, name: `Claude ${n}`, provider: "anthropic", efforts })),
];
const state = (id) => ({
  runtime: "Pi Durable 1.3.0",
  conversationId: id,
  selectedConversationId: id,
  auth: { connected: true, state: "connected", events: [] },
  anthropicAuth: { connected: true, state: "connected", events: [] },
  providerReady: true,
  thinkingLevel,
  models,
  extensions: [],
  conversations,
  workers: [],
  view: { entries: [], docs: { "pi.agent": { model: { provider: "anthropic", modelId: "claude-20" } } } },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state(Number(url.searchParams.get("conversationId") || 1)) });
  if (url.pathname === "/api/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations, rootId: 1 } });
  if (request.method() !== "POST") return route.fulfill({ json: {} });
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/conversations/organise") {
    const row = conversations.find((item) => String(item.id) === body.conversationId);
    Object.assign(row, body.title ? { title: body.title } : {}, "group" in body ? { group: body.group } : {}, "archived" in body ? { archived: body.archived } : {}, "pinned" in body ? { pinned: body.pinned } : {});
    return route.fulfill({ json: { conversation: row } });
  }
  if (url.pathname === "/api/conversations") {
    conversations.push({ id: 4, title: "New conversation" });
    return route.fulfill({ status: 201, json: { conversation: { id: 4, title: "New conversation" } } });
  }
  if (url.pathname === "/api/effort") thinkingLevel = body.effort;
  return route.fulfill({ status: 200, json: { ok: true } });
});
const sidebar = page.locator(".live-sidebar");
const organised = () => requests.filter((request) => request.path === "/api/conversations/organise").map((request) => request.body);
const menuFor = async (title) => {
  await sidebar.getByRole("button", { name: title, exact: true }).hover();
  await sidebar.getByRole("button", { name: `Options for ${title}` }).click();
};
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await sidebar.getByRole("button", { name: "Deploy watchdog", exact: true }).waitFor();

  // Archive: the row leaves Recents for a folded Archived section, and unarchives.
  await menuFor("Release notes");
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await sidebar.getByRole("button", { name: /^Archived/ }).waitFor();
  assert.deepEqual(organised().at(-1), { conversationId: "3", archived: true });
  assert.equal(await sidebar.getByRole("button", { name: "Release notes", exact: true }).count(), 0, "Archived starts folded");
  await sidebar.getByRole("button", { name: /^Archived/ }).click();
  await sidebar.getByRole("button", { name: "Release notes", exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/archived.png` });
  await menuFor("Release notes");
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await sidebar.getByRole("button", { name: /^Archived/ }).waitFor({ state: "detached" });
  assert.deepEqual(organised().at(-1), { conversationId: "3", archived: false });

  // Menu hotkeys: P pins and unpins, A archives and unarchives, and each closes the menu.
  await menuFor("Release notes");
  await page.keyboard.press("p");
  await sidebar.getByText("Pinned", { exact: true }).waitFor();
  assert.deepEqual(organised().at(-1), { conversationId: "3", pinned: true });
  assert.equal(await page.getByRole("menu").count(), 0, "a hotkey closes the menu");
  await page.screenshot({ path: `${evidence}/pinned.png` });
  await menuFor("Release notes");
  await page.getByRole("menuitem", { name: "Unpin" }).waitFor();
  await page.keyboard.press("p");
  await sidebar.getByText("Pinned", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(organised().at(-1), { conversationId: "3", pinned: false });
  await menuFor("Release notes");
  await page.keyboard.press("a");
  await sidebar.getByRole("button", { name: /^Archived/ }).waitFor();
  assert.deepEqual(organised().at(-1), { conversationId: "3", archived: true });
  // Archived is already unfolded from the check above; the browser remembers it.
  await menuFor("Release notes");
  await page.keyboard.press("a");
  await sidebar.getByRole("button", { name: /^Archived/ }).waitFor({ state: "detached" });
  assert.deepEqual(organised().at(-1), { conversationId: "3", archived: false });

  // Group: New group names a section above Recents; a second chat joins from its menu.
  await menuFor("Deploy watchdog");
  await page.getByRole("menuitem", { name: "Add to group" }).click();
  await page.getByRole("menuitem", { name: "New group…" }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("  Mars host ");
  await page.getByRole("button", { name: "Create group" }).click();
  await sidebar.getByRole("button", { name: /^Mars host/ }).waitFor();
  assert.deepEqual(organised().at(-1), { conversationId: "2", group: "Mars host" });
  await menuFor("Release notes");
  await page.getByRole("menuitem", { name: "Add to group" }).click();
  await page.getByRole("menuitem", { name: "Mars host" }).click();
  assert.deepEqual(organised().at(-1), { conversationId: "3", group: "Mars host" });
  await page.waitForFunction(() => document.querySelector('[aria-label="Group Mars host"] .live-count')?.textContent === "2");
  const order = await sidebar.locator(".live-group-toggle, .live-section-label").allInnerTexts();
  assert.ok(order[0].startsWith("Mars host") && order[1] === "Recents", "groups sit above the default Recents list: " + order);
  await page.screenshot({ path: `${evidence}/grouped.png` });
  await menuFor("Release notes");
  await page.getByRole("menuitem", { name: "Move to group" }).click();
  await page.getByRole("menuitem", { name: /^Remove from/ }).click();
  assert.deepEqual(organised().at(-1), { conversationId: "3", group: "" });

  // Rename.
  await menuFor("Deploy watchdog");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Chat name" }).fill("Watchdog fixes");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await sidebar.getByRole("button", { name: "Watchdog fixes", exact: true }).waitFor();
  assert.deepEqual(organised().at(-1), { conversationId: "2", title: "Watchdog fixes" });

  // Effort stays in view below 24 models and is sent for this chat.
  await page.getByRole("button", { name: "Choose model" }).click();
  const menu = page.getByRole("menu");
  const slider = menu.getByRole("slider");
  await slider.waitFor();
  const [menuBox, sliderBox] = [await menu.boundingBox(), await slider.boundingBox()];
  assert.ok(sliderBox.y >= menuBox.y && sliderBox.y + sliderBox.height <= menuBox.y + menuBox.height + 1, "Effort is visible without scrolling");
  assert.ok(sliderBox.y + sliderBox.height <= 800, "Effort is inside the viewport");
  await page.screenshot({ path: `${evidence}/effort.png` });
  await slider.focus();
  await slider.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute("aria-valuetext") === "High");
  assert.deepEqual(requests.find((request) => request.path === "/api/effort").body.effort, "high");
  await page.keyboard.press("Escape");

  // A new chat starts at the chosen effort.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await sidebar.getByRole("button", { name: "New conversation", exact: true }).waitFor();
  const created = requests.find((request) => request.path === "/api/conversations").body;
  assert.deepEqual(created, { provider: "anthropic", modelId: "claude-20", thinking: "high" });
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    mode: "browser-only fixtures",
    checks: ["archive and unarchive", "Archived folded by default", "new group", "join existing group", "groups above Recents", "remove from group", "rename", "effort visible below a long list", "effort sent", "new chat keeps effort"],
  };
  await writeFile(`${evidence}/organise-browser-check.json`, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
