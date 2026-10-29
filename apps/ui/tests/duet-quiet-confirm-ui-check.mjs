// Duet in the browser (docs/DUET.md), against routed fixtures: quiet results fold into one
// low-key card, a confirm box asks Go ahead or Don't and posts the answer, Not right posts a
// note for Duet's own bubbles (hover on a desktop, a long press on a phone), and the cache figure
// shows in the task strip. Screenshots go to MARS_DUET_SHOTS when set.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const posts = [];
const task = (id, label, state) => ({ id, conversationId: String(100 + Number(id.slice(1))), label, state, running: state === "running", model: "gpt-6-sol", progress: null, origin: "" });
const duet = (id, kind, text, extra = {}) => ({ id, from: "duet", kind, text, taskId: "T1", label: "Hotels", quote: "", ...extra });
let data = {
  threadId: "50",
  running: false,
  messages: [
    { id: "1", from: "owner", kind: "message", text: "Keep an eye on Tokyo hotel prices", taskId: "", label: "", quote: "" },
    duet("2", "reply", "Will do. I'll check them through the day.", { taskId: "", label: "" }),
    duet("3", "result", "Park Hyatt is still $420.", { quiet: true }),
    duet("4", "result", "No change at the Andaz.", { quiet: true }),
    duet("5", "result", "Flights unchanged.", { quiet: true, taskId: "T2", label: "Flights" }),
    duet("6", "result", "**Price drop:** Park Hyatt is now $360 a night.", { quote: "Tokyo hotel prices" }),
    duet("7", "confirm", "It's $360 and refundable. Book it?", { confirm: { id: "C1", state: "pending", action: "Book Park Hyatt Tokyo, 2 nights, $720" } }),
    duet("8", "confirm", "Shall I cancel the Andaz hold?", { confirm: { id: "C2", state: "pending", action: "Cancel the Andaz hold" } }),
  ],
  tasks: [task("T1", "Hotels", "running"), task("T2", "Flights", "done")],
  board: { version: 0, facts: {}, claims: {} },
  context: { cacheHitPercent: 91.2, cachedTokens: 109440, inputTokens: 120000, turns: 14 },
};
const update = (id, change) => {
  data = { ...data, messages: data.messages.map((m) => (m.id === id ? change(m) : m)) };
};
async function route(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (request) => {
    const url = new URL(request.request().url());
    if (url.pathname.startsWith("/api/duet")) {
      if (request.request().method() === "POST") {
        const body = request.request().postDataJSON();
        posts.push({ path: url.pathname, body });
        if (url.pathname === "/api/duet/open") return request.fulfill({ json: { threadId: "50" } });
        if (url.pathname === "/api/duet/confirm") {
          const message = data.messages.find((m) => m.confirm?.id === body.confirmId);
          update(message.id, (m) => ({ ...m, confirm: { ...m.confirm, state: body.answer } }));
          return request.fulfill({ json: { confirmId: body.confirmId, state: body.answer } });
        }
        if (url.pathname === "/api/duet/feedback") {
          update(body.messageId, (m) => ({ ...m, feedback: "wrong" }));
          return request.fulfill({ json: { messageId: body.messageId, feedback: "wrong" } });
        }
        return request.fulfill({ json: {} });
      }
      return request.fulfill({ json: data });
    }
    if (url.pathname === "/api/state")
      return request.fulfill({ json: {
        duet: true, runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
        auth: { connected: true, state: "connected", events: [] }, providerReady: true,
        models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }],
        view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
      } });
    return request.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
  });
}
const shots = process.env.MARS_DUET_SHOTS;
const checks = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await route(page);
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.getByRole("button", { name: "Duet", exact: true }).first().click();
  const thread = page.locator(".duet");
  await thread.getByText("Price drop").waitFor();

  // Quiet results: one collapsed, low-key card that expands to the bubbles.
  const quiet = thread.locator(".duet-quiet");
  assert.equal(await quiet.count(), 1, "three consecutive quiet bubbles make one card");
  const fold = quiet.getByRole("button", { name: /3 quiet updates/ });
  assert.equal(await fold.getAttribute("aria-expanded"), "false");
  assert.match(await fold.innerText(), /Hotels, Flights/);
  assert.equal(await thread.getByText("No change at the Andaz.").count(), 0, "folded bubbles are not shown");
  assert.equal(await fold.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "no attention colour");
  await fold.click();
  await quiet.getByText("No change at the Andaz.").waitFor();
  assert.equal(await quiet.locator(".duet-bubble").count(), 3);
  if (shots) await page.screenshot({ path: shots + "/duet-quiet.png" });
  await fold.click();
  await quiet.getByText("No change at the Andaz.").waitFor({ state: "detached" });
  checks.push("quiet results fold into one card that expands and collapses");

  // The cache figure, with a tooltip explaining it.
  const cache = thread.locator(".duet-cache");
  assert.equal(await cache.innerText(), "Cache 91%");
  assert.match(await cache.getAttribute("title"), /model provider reused[\s\S]*109,440 of 120,000/);
  checks.push("cache figure in the task strip");

  // Confirm: Go ahead posts yes, the box goes and the choice shows quietly.
  const book = thread.locator(".duet-row", { hasText: "Book it?" });
  assert.match(await book.locator(".duet-confirm").innerText(), /Book Park Hyatt Tokyo, 2 nights, \$720/);
  assert.equal(await book.getByRole("button", { name: "Not right" }).count(), 0, "a question is not marked Not right");
  if (shots) await page.screenshot({ path: shots + "/duet-confirm.png" });
  await book.getByRole("button", { name: "Go ahead" }).click();
  await book.getByText("You said go ahead").waitFor();
  assert.equal(await book.getByRole("button", { name: "Go ahead" }).count(), 0);
  assert.equal(await book.getByRole("button", { name: "Don't" }).count(), 0);
  assert.deepEqual(posts.filter((p) => p.path === "/api/duet/confirm").at(-1).body, { confirmId: "C1", answer: "yes" });
  const cancel = thread.locator(".duet-row", { hasText: "Andaz hold" });
  await cancel.getByRole("button", { name: "Don't" }).click();
  await cancel.getByText("You said don't").waitFor();
  assert.deepEqual(await cancel.getByRole("button").allTextContents(), [""], "only the reply arrow is left");
  assert.deepEqual(posts.filter((p) => p.path === "/api/duet/confirm").at(-1).body, { confirmId: "C2", answer: "no" });
  await page.waitForTimeout(1500);
  assert.equal(await thread.locator(".duet-confirm-buttons").count(), 0, "answered boxes stay answered after a reload");
  checks.push("confirm box: Go ahead and Don't post the right answer, then show the choice");

  // Not right on hover: a one-line note, posted with the message id.
  const reply = thread.locator(".duet-row", { hasText: "Will do." });
  const wrong = reply.getByRole("button", { name: "Not right" });
  assert.equal(await wrong.evaluate((el) => getComputedStyle(el).opacity), "0", "hidden until hover");
  await reply.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".duet-wrong")).opacity !== "0");
  await wrong.click();
  const note = reply.getByRole("textbox", { name: "What was wrong? (optional)" });
  await note.fill("I wanted the Shinjuku ones");
  if (shots) await page.screenshot({ path: shots + "/duet-not-right.png" });
  await note.press("Enter");
  await reply.getByText("Marked not right").waitFor();
  assert.deepEqual(posts.filter((p) => p.path === "/api/duet/feedback").at(-1).body, { messageId: "2", note: "I wanted the Shinjuku ones" });
  assert.equal(await reply.getByRole("button", { name: "Not right" }).count(), 0);
  assert.equal(await reply.getByRole("textbox").count(), 0);
  checks.push("Not right posts the message id and note, then shows a note");

  data = { ...data, context: { cacheHitPercent: null, cachedTokens: 0, inputTokens: 0, turns: 0 } };
  await cache.waitFor({ state: "detached" });
  checks.push("cache figure hidden when the host has none");

  // A phone: a long press on the bubble opens Not right; the note is optional.
  data = { ...data, context: { cacheHitPercent: 64, cachedTokens: 640, inputTokens: 1000, turns: 2 } };
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await route(phone);
  await phone.goto(new URL("?view=duet", uiBaseURL()).toString(), { waitUntil: "domcontentloaded", timeout: 180000 });
  const small = phone.locator(".duet");
  const drop = small.locator(".duet-row", { hasText: "Price drop" });
  await drop.waitFor({ timeout: 120000 });
  await phone.waitForFunction(() => Object.keys(document.querySelector(".duet-bubble") ?? {}).some((key) => key.startsWith("__reactProps")), null, { timeout: 60000 });
  const hidden = await drop.getByRole("button", { name: "Not right" }).boundingBox();
  assert.ok(hidden.width <= 1, "the button is only for screen readers on a phone");
  assert.equal(await small.locator(".duet-cache").innerText(), "Cache 64%");
  await drop.locator(".duet-bubble").evaluate(async (el) => {
    const at = { bubbles: true, pointerType: "touch", pointerId: 7, isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", at));
    await new Promise((done) => setTimeout(done, 800));
    el.dispatchEvent(new PointerEvent("pointerup", at));
  });
  const field = drop.getByRole("textbox", { name: "What was wrong? (optional)" });
  await field.waitFor();
  await drop.getByRole("button", { name: "Send" }).tap();
  await drop.getByText("Marked not right").waitFor();
  assert.deepEqual(posts.filter((p) => p.path === "/api/duet/feedback").at(-1).body, { messageId: "6", note: "" });
  const tapped = small.locator(".duet-row", { hasText: "Flights unchanged" });
  assert.equal(await tapped.count(), 0, "quiet bubbles stay folded on a phone");
  if (shots) await phone.screenshot({ path: shots + "/duet-phone-not-right.png" });
  checks.push("phone: long press opens Not right, an empty note posts");
  await phone.close();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  if (shots) await page.screenshot({ path: shots + "/duet-quiet-failure.png" }).catch(() => {});
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.stack || error).slice(0, 800) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
