import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

// Fixture-only: pages and conversations live in this file so the check needs no host.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/workbench-pages";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const text = (value) => [{ type: "text", text: value }];

function fixture() {
  const longChat = Array.from({ length: 24 }, (_, n) => ({
    id: n + 1,
    model: [
      { role: "user", content: text(`Fixture question ${n + 1}`) },
      { role: "assistant", content: text(`Fixture answer ${n + 1}. `.repeat(12)) },
    ],
  }));
  const db = {
    pages: new Map([
      ["release-plan", { text: "# Release plan (fixture)\n\nFixture page.", modified: Date.now() - 3600000 }],
      ["reading-notes", { text: "# Reading notes (fixture)", modified: Date.now() - 2 * 86400000 }],
    ]),
    conversations: new Map([
      ["1", { title: "Main fixture chat", entries: longChat, running: false }],
      ["3", { title: "Weekly notes (fixture)", entries: [], running: false }],
    ]),
    saves: [],
    chats: [],
    aborts: [],
    created: [],
    stateReads: new Map(),
  };
  const state = (id) => {
    const conversation = db.conversations.get(id) ?? db.conversations.get("1");
    return {
      runtime: "Pi Durable 1.3.0 (fixture)",
      providerReady: true,
      conversationId: id,
      selectedConversationId: id,
      conversationTitle: conversation.title,
      conversations: [...db.conversations].map(([key, row]) => ({ id: key, title: row.title, running: row.running })),
      auth: { connected: true, state: "connected", events: [] },
      models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["low", "medium"] }],
      thinkingLevel: "medium",
      extensions: [],
      view: {
        entries: conversation.entries,
        docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } }, ...(conversation.running ? { "pi.live": { run: { id: 1 } } } : {}) },
      },
    };
  };
  const summary = (name) => {
    const page = db.pages.get(name);
    return { name, title: /^# +(.+)$/m.exec(page.text)?.[1] || name, modified: page.modified, size: page.text.length };
  };
  const handle = (method, path, search, body) => {
    if (path === "/api/state") {
      const id = search.get("conversationId") || "1";
      db.stateReads.set(id, (db.stateReads.get(id) ?? 0) + 1);
      return [200, state(id)];
    }
    if (path === "/api/workbench/capabilities")
      return [200, { tools: { changes: { available: false, reason: "Fixture" }, files: { available: false, reason: "Fixture" }, terminal: { available: false, reason: "Fixture" }, "side-chat": { available: true }, page: { available: true }, browser: { available: false, reason: "Fixture" } } }];
    if (path === "/api/workbench/suggestions") return [200, { suggestions: [] }];
    if (path === "/api/workbench/pages" && method === "GET")
      return [200, { pages: [...db.pages.keys()].map(summary).sort((a, b) => b.modified - a.modified) }];
    if (path.startsWith("/api/workbench/pages/")) {
      const name = path.slice("/api/workbench/pages/".length);
      const page = db.pages.get(name);
      return page ? [200, { name, text: page.text, modified: page.modified }] : [404, { error: "That page does not exist." }];
    }
    if (path === "/api/workbench/pages" && method === "POST") {
      db.saves.push(body);
      let name = body.name;
      if (name === undefined) for (let n = 1; db.pages.has((name = n === 1 ? "untitled" : `untitled-${n}`)); n++);
      const current = db.pages.get(name);
      if (current ? body.baseModified !== current.modified : body.baseModified !== undefined)
        return [409, { error: "This page changed elsewhere since you opened it.", modified: current?.modified ?? 0 }];
      db.pages.set(name, { text: body.text, modified: Math.max(Date.now(), (current?.modified ?? 0) + 1) });
      return [current ? 200 : 201, summary(name)];
    }
    if (path === "/api/conversations" && method === "POST") {
      db.created.push(body);
      db.conversations.set("9", { title: body.title || "New conversation", entries: [], running: false });
      return [201, { conversation: { id: "9", title: body.title || "New conversation" } }];
    }
    if (path === "/api/chat") {
      db.chats.push(body);
      const conversation = db.conversations.get(String(body.conversationId));
      conversation.entries.push({ id: Date.now(), model: [{ role: "user", content: text(body.text) }, { role: "assistant", content: text("**Fixture** side reply, still working.") }] });
      conversation.running = true;
      return [202, { submissionId: 1 }];
    }
    if (path === "/api/abort") {
      db.aborts.push(body);
      db.conversations.get(String(body.conversationId)).running = false;
      return [200, { aborted: true }];
    }
    if (path === "/api/plugins") return [200, { plugins: [] }];
    return [200, { accepted: true }];
  };
  return { db, handle };
}

async function open(viewport, { theme } = {}) {
  const { db, handle } = fixture();
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  if (theme) await context.addInitScript((value) => localStorage.setItem("mars-live-theme", value), theme);
  const tab = await context.newPage();
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const [status, json] = handle(request.method(), url.pathname, url.searchParams, request.method() === "POST" ? request.postDataJSON() : undefined);
    return route.fulfill({ status, json });
  });
  await tab.goto(new URL("?conversation=1", uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(tab);
  await tab.getByText("Fixture question 24").waitFor();
  return { tab, db };
}
const until = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

try {
  const { tab: desktop, db } = await open({ width: 1440, height: 900 });
  const main = desktop.getByRole("textbox", { name: "Message Mars" });
  await main.fill("Main draft stays put");
  await desktop.getByRole("button", { name: "Open workbench" }).click();
  const pane = desktop.getByRole("region", { name: "Workbench" });
  await pane.getByRole("button", { name: /^Pages/ }).click();

  // Pages list, newest first, then New page creates a generated name.
  const list = pane.getByRole("list", { name: "Pages" });
  await list.waitFor();
  assert.deepEqual(await list.getByRole("button").evaluateAll((rows) => rows.map((row) => row.querySelector(".wb-page-row-title").textContent)), ["Release plan (fixture)", "Reading notes (fixture)"]);
  await desktop.screenshot({ path: `${evidence}/desktop-dark-pages-list.png` });
  await pane.getByRole("button", { name: "New page", exact: true }).click();
  const editor = pane.getByRole("textbox", { name: "Page text" });
  await editor.waitFor();
  assert.deepEqual(db.saves[0], { text: "" }, "New page posts without a name");
  await pane.getByText("pages/untitled.md").waitFor();
  await pane.getByRole("status").getByText("Saved", { exact: true }).waitFor();

  // Debounced autosave: one save after typing stops, carrying the base modified time.
  const base = db.pages.get("untitled").modified;
  await editor.pressSequentially("# Launch notes\n\nShip **bold** things.", { delay: 15 });
  await pane.getByRole("status").getByText("Unsaved changes").waitFor();
  assert.equal(db.saves.length, 1, "no save while typing");
  await pane.getByRole("status").getByText("Saved", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(db.saves.length, 2, "exactly one debounced save");
  assert.deepEqual(db.saves[1], { name: "untitled", text: "# Launch notes\n\nShip **bold** things.", baseModified: base });
  await pane.getByRole("heading", { name: "Launch notes" }).waitFor();

  // Live preview renders Markdown.
  await pane.getByRole("button", { name: "Preview" }).click();
  assert.equal(await pane.getByRole("article", { name: "Page preview" }).locator("strong").textContent(), "bold");
  await desktop.screenshot({ path: `${evidence}/desktop-dark-page-preview.png` });
  await pane.getByRole("button", { name: "Edit" }).click();

  // Conflict: a newer save elsewhere is never overwritten silently.
  db.pages.set("untitled", { text: "# Edited elsewhere", modified: db.pages.get("untitled").modified + 5000 });
  await editor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await editor.pressSequentially(" Mine.");
  await pane.getByText("Changed elsewhere: reload or overwrite").waitFor({ timeout: 3000 });
  assert.equal(db.pages.get("untitled").text, "# Edited elsewhere", "conflicting save left the newer text alone");
  await editor.pressSequentially(" More.");
  await desktop.waitForTimeout(1200);
  assert.equal(db.saves.filter((save) => save.name === "untitled").length, 2, "no further saves while the conflict is open");
  await desktop.screenshot({ path: `${evidence}/desktop-dark-page-conflict.png` });
  await pane.getByRole("button", { name: "Overwrite" }).click();
  await pane.getByRole("status").getByText("Saved", { exact: true }).waitFor();
  assert.equal(db.pages.get("untitled").text, "# Launch notes\n\nShip **bold** things. Mine. More.", "explicit overwrite wins");
  db.pages.set("untitled", { text: "# Remote rewrite", modified: db.pages.get("untitled").modified + 5000 });
  await editor.pressSequentially("!");
  await pane.getByText("Changed elsewhere: reload or overwrite").waitFor({ timeout: 3000 });
  await pane.getByRole("button", { name: "Reload" }).click();
  await until(async () => (await editor.inputValue()) === "# Remote rewrite", "reload shows the newer text");
  await pane.getByRole("status").getByText("Saved", { exact: true }).waitFor();

  // Back to the list shows the new page first.
  await pane.getByRole("button", { name: "All pages" }).click();
  await list.getByRole("button", { name: /Remote rewrite/ }).waitFor();
  assert.equal(await main.inputValue(), "Main draft stays put", "pages never touch the main draft");

  // Side chat: scroll the main transcript first, then prove nothing in it moves.
  const viewport = desktop.locator(".live-viewport");
  await viewport.evaluate((node) => (node.scrollTop = 400));
  await desktop.waitForTimeout(400);
  const scrolled = await viewport.evaluate((node) => node.scrollTop);
  await desktop.getByRole("button", { name: "New workbench tab" }).click();
  await pane.getByRole("button", { name: /^Side chat/ }).click();
  await pane.getByRole("heading", { name: "Side chat" }).waitFor();
  assert.equal(await pane.getByRole("button", { name: /Main fixture chat/ }).isDisabled(), true, "the main conversation is not offered");
  await pane.getByRole("button", { name: /Weekly notes/ }).waitFor();
  await pane.getByRole("button", { name: "New side conversation" }).click();
  const side = pane.getByRole("textbox", { name: "Message side chat" });
  await side.waitFor();
  assert.deepEqual(db.created, [{ title: "Side chat", parentId: "1", provider: "openai", modelId: "gpt-6-sol" }], "the side chat is created under the main chat");
  await until(async () => !(await side.isDisabled()), "side composer enables");
  await side.fill("Side question");
  await side.press("Enter");
  await pane.getByText("side reply, still working.").waitFor();
  assert.equal(db.chats.length, 1);
  assert.equal(db.chats[0].conversationId, "9", "side chat sends to its own conversation");
  assert.equal(db.chats[0].text, "Side question");
  assert.match(db.chats[0].requestId, /^[0-9a-f-]{36}$/, "every send carries a requestId");
  const stop = pane.getByRole("button", { name: "Stop side chat" });
  await stop.waitFor();
  assert.equal(await desktop.getByRole("button", { name: "Stop response" }).count(), 0, "main chat is not running");
  await desktop.screenshot({ path: `${evidence}/desktop-dark-side-chat.png` });
  await stop.click();
  await pane.getByRole("button", { name: "Send to side chat" }).waitFor();
  assert.deepEqual(db.aborts, [{ conversationId: "9" }], "stop aborts only the side conversation");

  assert.equal(new URL(desktop.url()).searchParams.get("conversation"), "1", "main selection unchanged");
  assert.equal(await main.inputValue(), "Main draft stays put", "main draft unchanged");
  assert.equal(await desktop.locator(".live-main").getByText("Side question").count(), 0, "side messages stay out of the main transcript");
  assert.ok(Math.abs((await viewport.evaluate((node) => node.scrollTop)) - scrolled) < 2, "main scroll position unchanged");

  // Polling runs only while the side chat is visible.
  await desktop.getByRole("tab", { name: "Remote rewrite" }).or(desktop.getByRole("tab", { name: "Pages" })).first().click();
  await desktop.waitForTimeout(300);
  const hidden = db.stateReads.get("9");
  await desktop.waitForTimeout(3200);
  assert.equal(db.stateReads.get("9"), hidden, "no side polling while its tab is hidden");
  await desktop.getByRole("tab", { name: "Side chat" }).click();
  await until(() => db.stateReads.get("9") > hidden, "polling resumes when shown");

  // Reload restores the side chat tab on the same conversation.
  await desktop.reload();
  await desktop.getByRole("tab", { name: "Side chat" }).click();
  await pane.getByText("Side question").waitFor();

  const { tab: light } = await open({ width: 1440, height: 900 }, { theme: "light" });
  await light.getByRole("button", { name: "Open workbench" }).click();
  const lightPane = light.getByRole("region", { name: "Workbench" });
  await lightPane.getByRole("button", { name: /^Pages/ }).click();
  await lightPane.getByRole("button", { name: /Release plan/ }).click();
  await lightPane.getByRole("status").getByText("Saved", { exact: true }).waitFor();
  await light.screenshot({ path: `${evidence}/desktop-light-page.png` });
  await lightPane.getByRole("button", { name: "New workbench tab" }).click();
  await lightPane.getByRole("button", { name: /^Side chat/ }).click();
  await lightPane.getByRole("button", { name: /Weekly notes/ }).click();
  await lightPane.getByText("No messages yet.").waitFor();
  await light.screenshot({ path: `${evidence}/desktop-light-side-chat.png` });

  for (const theme of ["dark", "light"]) {
    const { tab: mobile } = await open({ width: 390, height: 844 }, { theme });
    await mobile.getByRole("button", { name: "Open workbench" }).click();
    const sheet = mobile.getByRole("region", { name: "Workbench" });
    await sheet.getByRole("button", { name: /^Pages/ }).click();
    await sheet.getByRole("button", { name: /Release plan/ }).click();
    await sheet.getByRole("textbox", { name: "Page text" }).waitFor();
    await sheet.getByRole("status").getByText("Saved", { exact: true }).waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow on the page editor (${theme})`);
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}-page.png` });
    await sheet.getByRole("button", { name: "New workbench tab" }).click();
    await sheet.getByRole("button", { name: /^Side chat/ }).click();
    await sheet.getByRole("button", { name: "New side conversation" }).click();
    const box = sheet.getByRole("textbox", { name: "Message side chat" });
    await until(async () => !(await box.isDisabled()), "mobile side composer enables");
    await box.fill("Phone side question");
    await box.press("Enter");
    await sheet.getByText("side reply, still working.").waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow in the side chat (${theme})`);
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}-side-chat.png` });
  }

  assert.deepEqual(errors, []);
  console.log(
    "PASS workbench pages and side chat: list newest first, generated name, one debounced save with baseModified, preview, 409 conflict held until explicit overwrite or reload, side conversation create and send with requestId, scoped stop, main draft, selection and scroll unchanged, visible-only polling, reload restore, mobile without overflow",
  );
} finally {
  await browser.close();
}
