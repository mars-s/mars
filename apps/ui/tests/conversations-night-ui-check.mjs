// Night fixes for conversations, in the browser against routed fixtures:
// - an unknown ?conversation= id opens the main conversation instead of blocking the workspace;
// - a send that fails after the owner switched chats comes back into that chat's composer, with
//   an error naming it, both when the chat is left and when it is opened again;
// - a poll that was in flight before a rename, pin or archive cannot undo it, and a failed change
//   no longer wipes out another change confirmed in the meantime.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { browserLaunchOptions, uiBaseURL, waitForHydration, composerText, waitForComposer } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/conversations-night-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

/** A fresh page with its own routed host: three chats, or whatever the scenario changes. */
async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const fixture = {
    page,
    errors: [],
    requests: [],
    conversations: [
      { id: 1, title: "Main conversation" },
      { id: 2, title: "Release notes" },
      { id: 3, title: "Deploy watchdog" },
      { id: 4, title: "Roadmap" },
    ],
    /** Set to a deferred to hold the next /api/state answers, which keep the rows they arrived with. */
    stateGate: null,
    heldStates: 0,
    /** Answers POST /api/chat; return a status and body. */
    chat: async () => ({ status: 202, json: { submissionId: "9" } }),
    /** Answers POST /api/conversations/organise before it applies the change, or fails it. */
    organise: async () => true,
    missing: new Set(),
  };
  page.on("pageerror", (error) => fixture.errors.push(error.message));
  const state = (id) => ({
    runtime: "Pi Durable 1.3.0",
    conversationId: id,
    selectedConversationId: id,
    auth: { connected: true, state: "connected", events: [] },
    providerReady: true,
    models: [{ id: "gpt-6-luna", name: "Luna", provider: "openai" }],
    extensions: [],
    conversations: structuredClone(fixture.conversations),
    workers: [],
    view: {
      entries: [],
      docs: {
        "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } },
      },
    },
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/state") {
      const id = url.searchParams.get("conversationId") || "1";
      if (fixture.missing.has(id)) return route.fulfill({ status: 404, json: { error: "Conversation not found" } });
      const answer = state(Number(id));
      if (fixture.stateGate) {
        fixture.heldStates++;
        await fixture.stateGate.promise;
      }
      return route.fulfill({ json: answer });
    }
    if (url.pathname === "/api/conversations" && request.method() === "GET")
      return route.fulfill({ json: { conversations: fixture.conversations, rootId: 1 } });
    if (request.method() !== "POST") return route.fulfill({ json: {} });
    const body = request.postDataJSON();
    fixture.requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/chat") return route.fulfill(await fixture.chat(body));
    if (url.pathname === "/api/conversations/organise") {
      if (!(await fixture.organise(body))) return route.fulfill({ status: 500, json: { error: "Pi could not file it" } });
      const row = fixture.conversations.find((item) => String(item.id) === body.conversationId);
      Object.assign(row, body.title ? { title: body.title } : {}, "archived" in body ? { archived: body.archived } : {}, "pinned" in body ? { pinned: body.pinned } : {});
      return route.fulfill({ json: { conversation: row } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  return fixture;
}
async function load(fixture, search = "") {
  await fixture.page.goto(new URL(search, uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(fixture.page);
  await waitForComposer(fixture.page);
}
const sidebarOf = (page) => page.locator(".live-sidebar");
/** Open a chat from the sidebar. The composer stays read-only while a send is in flight, so do not wait for it. */
async function choose(page, title) {
  await sidebarOf(page).getByRole("button", { name: title, exact: true }).click();
  await page.waitForFunction((name) => document.querySelector(".live-sidebar .live-conversation[aria-current='page']")?.textContent?.includes(name), title);
  await page.getByText("Luna on Pi").waitFor();
  await page.waitForTimeout(300);
}
const checks = [];
/** MARS_CHECK_ONLY=2,3 runs only those scenarios, to show each one failing on older code. */
const only = (process.env.MARS_CHECK_ONLY || "").split(",").filter(Boolean);
const scenario = (number) => !only.length || only.includes(String(number));
try {
  // 1. An unknown chat id in the address opens the main conversation, with a note.
  if (scenario(1)) {
    const fixture = await open();
    fixture.missing.add("412");
    const { page } = fixture;
    await page.goto(new URL("/?conversation=412", uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
    await waitForHydration(page);
    await page.getByText("Chat 412 was not found, so the main conversation is open instead.").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "1");
    await sidebarOf(page).getByRole("button", { name: "Release notes", exact: true }).waitFor();
    assert.equal(await sidebarOf(page).getByRole("button", { name: "New chat" }).isEnabled(), true, "New chat works again");
    await waitForComposer(page);
    await page.screenshot({ path: `${evidence}/unknown-id.png` });
    assert.deepEqual(fixture.errors, []);
    await page.close();
    checks.push("unknown id opens the main conversation");
  }

  // 2. A send that fails after switching chats goes back into that chat's composer.
  if (scenario(2)) {
    const fixture = await open();
    const { page } = fixture;
    await load(fixture, "/?conversation=2");
    const input = page.getByRole("textbox", { name: "Message Mars" });
    let answer = deferred();
    fixture.chat = async () => answer.promise;
    await input.fill("Draft the release notes");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent === "");
    await choose(page, "Main conversation");
    answer.resolve({ status: 400, json: { error: "Connect the selected model provider." } });
    // A slow dev server can let the browser's 15 second limit fail the send first; either reason will do.
    await page.getByRole("alert").getByText(/^Your message to "Release notes" was not sent \(.+\)\. It is back in that chat's message box\.$/).waitFor({ timeout: 20000 });
    assert.equal(await composerText(input), "", "the open chat's composer is left alone");
    await choose(page, "Release notes");
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent === "Draft the release notes", null, { timeout: 10000 });
    checks.push("failed send after leaving a chat returns to its draft");

    // Left and opened again before the failure: the text comes back into the open composer.
    await input.fill("");
    answer = deferred();
    await input.fill("Check the changelog");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent === "");
    await choose(page, "Main conversation");
    await choose(page, "Release notes");
    answer.resolve({ status: 400, json: { error: "Connect the selected model provider." } });
    await page.getByRole("alert").getByText(/^Your message was not sent \(.+\)\. It is back in the message box\.$/).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent === "Check the changelog", null, { timeout: 10000 });
    await page.screenshot({ path: `${evidence}/failed-send-returned.png` });
    assert.deepEqual(fixture.errors, []);
    await page.close();
    checks.push("failed send after leaving and reopening a chat returns to its composer");
  }

  // 3. A poll that left before an archive cannot bring the row back.
  if (scenario(3)) {
    const fixture = await open();
    const { page } = fixture;
    await load(fixture);
    const sidebar = sidebarOf(page);
    await sidebar.getByRole("button", { name: "Release notes", exact: true }).waitFor();
    const menuFor = async (title) => {
      await sidebar.getByRole("button", { name: title, exact: true }).hover();
      await sidebar.getByRole("button", { name: `Options for ${title}` }).click();
    };
    fixture.stateGate = deferred();
    for (let n = 0; n < 50 && !fixture.heldStates; n++) await page.waitForTimeout(100);
    assert.ok(fixture.heldStates, "a poll is on its way");
    const organised = deferred();
    fixture.organise = async () => (await organised.promise, true);
    await menuFor("Release notes");
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await sidebar.getByRole("button", { name: /^Archived/ }).waitFor();
    const gate = fixture.stateGate;
    fixture.stateGate = null;
    gate.resolve();
    await page.waitForTimeout(400);
    assert.equal(await sidebar.getByRole("button", { name: /^Archived/ }).count(), 1, "the older poll is dropped");
    assert.equal(await sidebar.getByRole("button", { name: "Release notes", exact: true }).count(), 0, "the archived row stays out of Recents");
    organised.resolve();
    await page.waitForTimeout(400);
    assert.equal(await sidebar.getByRole("button", { name: /^Archived/ }).count(), 1, "the host confirms the archive");
    checks.push("an older poll cannot undo an archive");

    // A failed change no longer puts back the rows from when it was made.
    const failing = deferred();
    fixture.organise = async (body) => (body.conversationId === "3" ? (await failing.promise, false) : true);
    await menuFor("Deploy watchdog");
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await menuFor("Roadmap");
    await page.keyboard.press("p");
    await sidebar.getByText("Pinned", { exact: true }).waitFor();
    // Wait for the host to confirm the pin, then hold the polls so only the failure can change rows.
    for (let n = 0; n < 50 && !fixture.requests.some((request) => request.body.pinned === true); n++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    fixture.stateGate = deferred();
    failing.resolve();
    await page.getByText("Pi could not file it").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    assert.equal(await sidebar.getByText("Pinned", { exact: true }).count(), 1, "the confirmed pin stays after another change fails");
    const held = fixture.stateGate;
    fixture.stateGate = null;
    held.resolve();
    await sidebar.getByRole("button", { name: "Deploy watchdog", exact: true }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${evidence}/organise-after-failure.png` });
    assert.deepEqual(fixture.errors, []);
    await page.close();
    checks.push("a failed change keeps changes confirmed meanwhile, then shows the host's rows");
  }
  const result = { passed: true, mode: "browser-only fixtures", checks };
  await writeFile(`${evidence}/conversations-night-browser-check.json`, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
