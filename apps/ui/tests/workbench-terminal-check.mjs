import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

// Fixture-only: the terminal routes are a scripted stand-in answered in this test, never a real shell.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/workbench-terminal";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const state = {
  runtime: "Pi Durable 1.3.0",
  providerReady: true,
  conversationId: "1",
  selectedConversationId: "1",
  conversationTitle: "Workbench terminal fixture",
  conversations: [{ id: "1", title: "Workbench terminal fixture" }],
  auth: { connected: true, state: "connected", events: [] },
  models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["low", "medium"] }],
  thinkingLevel: "medium",
  extensions: [],
  view: { entries: [{ id: 1, model: [{ role: "user", content: [{ type: "text", text: "Open a terminal" }] }] }], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } } } },
};
const capabilities = {
  tools: Object.fromEntries(["changes", "files", "terminal", "side-chat", "page", "browser"].map((tool) => [tool, { available: true }])),
};

/** One fake host per browser context: sessions, a byte log per session, and a request log. */
function fakeHost() {
  const sessions = new Map();
  const log = [];
  let next = 0;
  const prompt = "\x1b[32mfixture\x1b[0m:workspace $ ";
  const push = (session, text) => {
    session.out = Buffer.concat([session.out, Buffer.from(text)]);
    for (const wake of session.waiters.splice(0)) wake();
  };
  const reply = (session, since) => ({
    offset: session.out.length,
    data: session.out.subarray(Math.min(since, session.out.length)).toString("base64"),
    ...(session.exited ? { exited: true, exitCode: session.exitCode } : {}),
  });
  return {
    sessions,
    log,
    failPolls: 0,
    async handle(route) {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.method() === "POST" ? JSON.parse(request.postData() || "{}") : {};
      log.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/workbench/terminal" && request.method() === "POST") {
        const id = (++next).toString(16).padStart(24, "0");
        const session = { out: Buffer.alloc(0), line: "", waiters: [], exited: false, size: `${body.rows} ${body.cols}`, created: body };
        sessions.set(id, session);
        push(session, prompt);
        return route.fulfill({ status: 201, json: { id } });
      }
      const match = /^\/api\/workbench\/terminal\/([a-f0-9]{24})(?:\/(input|resize|kill))?$/.exec(url.pathname);
      if (!match) return route.fulfill({ json: { accepted: true } });
      const session = sessions.get(match[1]);
      if (!session) return route.fulfill({ status: 404, json: { error: "Terminal session not found" } });
      if (!match[2]) {
        if (this.failPolls > 0) {
          this.failPolls--;
          return route.fulfill({ status: 502, json: { error: "Cannot reach the private Pi backend." } });
        }
        const since = Number(url.searchParams.get("since"));
        if (session.out.length > since || session.exited) return route.fulfill({ json: reply(session, since) });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          session.waiters.push(() => (clearTimeout(timer), resolve()));
        });
        return route.fulfill({ json: reply(session, since) }).catch(() => {});
      }
      if (match[2] === "kill") {
        session.exited = true;
        session.exitCode = 129;
        push(session, "");
        return route.fulfill({ json: { id: match[1], exited: true, exitCode: 129 } });
      }
      if (match[2] === "resize") {
        session.size = `${body.rows} ${body.cols}`;
        return route.fulfill({ json: { cols: body.cols, rows: body.rows } });
      }
      for (const char of Buffer.from(body.data, "base64").toString()) {
        if (char !== "\r") {
          session.line += char;
          push(session, char);
          continue;
        }
        const command = session.line.trim();
        session.line = "";
        if (command === "exit") {
          session.exited = true;
          session.exitCode = 3;
          push(session, "\r\nlogout\r\n");
        } else push(session, `\r\n${command === "stty size" ? session.size : command === "colours" ? "\x1b[31mred\x1b[0m \x1b[34mblue\x1b[0m \x1b[1;33mbold amber\x1b[0m" : `ran: ${command}`}\r\n${prompt}`);
      }
      return route.fulfill({ json: { accepted: 1 } });
    },
  };
}

async function open({ viewport, theme = "dark", storage }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));
  const host = fakeHost();
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/workbench/terminal")) return host.handle(route);
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/workbench/capabilities") return route.fulfill({ json: capabilities });
    if (path === "/api/workbench/suggestions") return route.fulfill({ json: { suggestions: [] } });
    return route.fulfill({ json: { accepted: true } });
  });
  await page.addInitScript(
    ({ theme, storage }) => {
      localStorage.setItem("mars-live-theme", theme);
      if (storage && !sessionStorage.getItem("seeded")) {
        localStorage.setItem("mars-workbench-v1", storage);
        sessionStorage.setItem("seeded", "1");
      }
    },
    { theme, storage },
  );
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  return { page, host, context };
}

const screenText = (page) => page.locator(".wb-term-screen .xterm-rows").innerText();
async function waitForText(page, pattern, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = await screenText(page).catch(() => "");
    if (pattern.test(text)) return text;
    await page.waitForTimeout(100);
  }
  assert.fail(`expected ${pattern} on the terminal screen, saw ${JSON.stringify(text.slice(-300))}`);
}
async function type(page, text) {
  await page.locator(".wb-term-screen .xterm-helper-textarea").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
const storedSession = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("mars-workbench-v1")).tabs.find((tab) => tab.kind === "terminal")?.sessionId);

try {
  // Desktop, dark: open from the launcher, round trip, colours, resize, reload reattaches.
  const { page: desktop, host } = await open({ viewport: { width: 1440, height: 900 } });
  const xtermLoaded = () => desktop.evaluate(() => typeof customElements !== "undefined" && performance.getEntriesByType("resource").some((entry) => /xterm/i.test(entry.name)));
  const before = await xtermLoaded();
  await desktop.getByRole("button", { name: "Open workbench" }).click();
  await desktop.locator(".wb-tool").filter({ hasText: "Terminal" }).click();
  await desktop.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  assert.equal(before, false, "xterm is not loaded until a terminal opens");
  assert.equal(await xtermLoaded(), true, "xterm is fetched as its own chunk when the pane opens");
  await waitForText(desktop, /fixture:workspace \$/);
  const created = [...host.sessions.values()][0].created;
  assert.ok(created.cols > 40 && created.rows > 10, `session created at the pane's size (${created.cols}x${created.rows})`);
  await type(desktop, "echo hello");
  await waitForText(desktop, /ran: echo hello/);
  await type(desktop, "colours");
  await waitForText(desktop, /bold amber/);
  const first = await storedSession(desktop);
  assert.match(first, /^[a-f0-9]{24}$/, "the tab stores its session id");
  const paint = () =>
    desktop.evaluate(() => {
      const rgb = (colour) => colour.match(/[\d.]+/g).slice(0, 4).map(Number);
      const probe = document.createElement("span");
      probe.style.color = "var(--sidebar)";
      document.body.append(probe);
      const sidebar = rgb(getComputedStyle(probe).color).slice(0, 3);
      probe.remove();
      const layer = (selector) => rgb(getComputedStyle(document.querySelector(`.wb-term-screen ${selector}`)).backgroundColor);
      return { sidebar, themed: layer(".xterm-scrollable-element").slice(0, 3), viewportAlpha: layer(".xterm-viewport")[3] ?? 1 };
    });
  const dark = await paint();
  assert.deepEqual(dark.themed, dark.sidebar, "terminal background is the Mars sidebar token");
  assert.equal(dark.viewportAlpha, 0, "xterm's default black viewport is not painted");
  await desktop.screenshot({ path: `${evidence}/desktop-dark.png` });

  // Resizing the pane refits the terminal and tells the host.
  const divider = desktop.getByRole("separator", { name: "Resize workbench" });
  const resizesBefore = host.log.filter((line) => line.endsWith("/resize")).length;
  await divider.focus();
  await desktop.keyboard.press("Shift+ArrowLeft");
  await desktop.keyboard.press("Shift+ArrowLeft");
  await desktop.waitForTimeout(500);
  assert.ok(host.log.filter((line) => line.endsWith("/resize")).length > resizesBefore, "a wider pane sends a resize");
  await type(desktop, "stty size");
  const size = (await waitForText(desktop, /\n\d+ \d+\n/)).match(/\n(\d+) (\d+)\n/);
  assert.ok(Number(size[2]) > created.cols, `stty reports the wider size (${size[2]} > ${created.cols})`);

  // Theme follows Settings without a reload.
  await desktop.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await desktop.waitForTimeout(200);
  const lit = await paint();
  assert.notDeepEqual(lit.sidebar, dark.sidebar);
  assert.deepEqual(lit.themed, lit.sidebar, "terminal theme follows data-theme changes");
  await desktop.screenshot({ path: `${evidence}/desktop-light.png` });
  await desktop.evaluate(() => (document.documentElement.dataset.theme = "dark"));

  // Reload: the same session is reattached and its output replayed.
  const createsBefore = host.log.filter((line) => line === "POST /api/workbench/terminal").length;
  await desktop.reload();
  await desktop.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  await waitForText(desktop, /ran: echo hello/);
  assert.equal(await storedSession(desktop), first, "reload keeps the session id");
  assert.equal(host.log.filter((line) => line === "POST /api/workbench/terminal").length, createsBefore, "reload does not create a session");

  // Host trouble shows Reconnecting, then recovers on its own.
  host.failPolls = 2;
  await type(desktop, "echo again");
  await desktop.getByRole("status").filter({ hasText: "Reconnecting…" }).waitFor();
  await desktop.getByText("Retrying automatically.").waitFor();
  await desktop.getByRole("status").filter({ hasText: "Connected" }).waitFor({ timeout: 10000 });
  await waitForText(desktop, /ran: echo again/);

  // A shell that exits shows its code and offers a new session.
  await type(desktop, "exit");
  await desktop.getByRole("status").filter({ hasText: "Session ended (exit 3)" }).waitFor();
  await desktop.screenshot({ path: `${evidence}/desktop-ended.png` });
  await desktop.locator(".wb-term-notice").getByRole("button", { name: "New session" }).click();
  await desktop.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  const second = await storedSession(desktop);
  assert.notEqual(second, first, "New session replaces the tab's session");

  // End session from the pane menu kills it on the host.
  await desktop.getByRole("button", { name: "Terminal options" }).click();
  await desktop.getByRole("menuitem", { name: "End session" }).click();
  await desktop.getByRole("status").filter({ hasText: "Session ended (exit 129)" }).waitFor();
  assert.ok(host.log.includes(`POST /api/workbench/terminal/${second}/kill`), "End session calls kill");
  await desktop.getByRole("button", { name: "Terminal options" }).click();
  assert.equal(await desktop.getByRole("menuitem", { name: "End session" }).getAttribute("aria-disabled"), "true", "End session is disabled once ended");
  await desktop.keyboard.press("Escape");

  // Closing the tab detaches without killing.
  await desktop.locator(".wb-term-notice").getByRole("button", { name: "New session" }).click();
  await desktop.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  const third = await storedSession(desktop);
  await desktop.getByRole("button", { name: "Close Terminal tab" }).click();
  await desktop.waitForTimeout(300);
  assert.ok(!host.log.includes(`POST /api/workbench/terminal/${third}/kill`), "closing the tab does not end the session");

  // A stored session the host no longer has says so.
  const stale = JSON.stringify({ open: true, expanded: false, width: 560, tabs: [{ id: "t1", kind: "terminal", sessionId: "f".repeat(24) }], activeId: "t1" });
  const { page: gone } = await open({ viewport: { width: 1440, height: 900 }, storage: stale });
  await gone.getByRole("status").filter({ hasText: "Session not found" }).waitFor();
  await gone.getByText("no longer on the host").waitFor();

  // Mobile, both themes: full-screen sheet, no horizontal overflow, typing works.
  for (const theme of ["dark", "light"]) {
    const { page: mobile } = await open({ viewport: { width: 390, height: 844 }, theme });
    await mobile.getByRole("button", { name: "Open workbench" }).click();
    await mobile.locator(".wb-tool").filter({ hasText: "Terminal" }).click();
    await mobile.getByRole("status").filter({ hasText: "Connected" }).waitFor();
    await type(mobile, "echo phone");
    await waitForText(mobile, /ran: echo phone/);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow at 390px");
    const box = await mobile.locator(".wb-term-screen").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, "terminal fits the phone width");
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}.png` });
  }
  // Desktop light from a fresh load.
  const { page: light } = await open({ viewport: { width: 1440, height: 900 }, theme: "light" });
  await light.getByRole("button", { name: "Open workbench" }).click();
  await light.locator(".wb-tool").filter({ hasText: "Terminal" }).click();
  await light.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  await type(light, "colours");
  await waitForText(light, /bold amber/);
  await light.screenshot({ path: `${evidence}/desktop-light-fresh.png` });

  assert.deepEqual(errors, []);
  console.log("PASS workbench terminal UI: lazy xterm, launcher opens a session at pane size, echo round trip, ANSI colours, Mars token theme that follows data-theme, resize refits and reaches stty, reload reattaches without a new session, Reconnecting then recovery, exit code, New session, End session kills, closing the tab detaches, missing session, phone sheet without overflow");
} finally {
  await browser.close();
}
