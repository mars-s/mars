// Duet in the browser (docs/DUET.md), against routed fixtures: the sidebar entry and its address,
// iMessage bubbles in Duet orange and the owner's grey, task labels and quotes, the task strip,
// replying to one task (the message carries its id), plain messages to the front desk, Stop, and
// the typing indicator. Screenshots go to MARS_DUET_SHOTS when set.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const posts = [];
const task = (id, label, state, extra = {}) => ({ id, conversationId: String(100 + Number(id.slice(1))), label, state, running: state === "running", model: "gpt-6-sol", progress: null, origin: "", createdAt: "", updatedAt: "", ...extra });
let data = {
  threadId: "50",
  running: false,
  messages: [
    { id: "1", from: "owner", kind: "message", text: "Find me a hotel in Tokyo and a Friday flight", taskId: "", label: "", quote: "" },
    { id: "2", from: "duet", kind: "reply", text: "On it. I'll look at hotels and flights at the same time.", taskId: "", label: "", quote: "" },
    { id: "3", from: "system", kind: "started", text: "Started Hotels", taskId: "T1", label: "Hotels", quote: "" },
    { id: "4", from: "system", kind: "started", text: "Started Flights", taskId: "T2", label: "Flights", quote: "" },
    { id: "5", from: "system", kind: "mail", text: "Hotels to Flights: What time do you land?", taskId: "T1", label: "Hotels", quote: "" },
    { id: "6", from: "duet", kind: "result", text: "**QF25** leaves Friday 9:05am, $412 return. [Book](https://example.com/qf25)", taskId: "T2", label: "Flights", quote: "a Friday flight" },
  ],
  tasks: [task("T1", "Hotels", "running", { progress: { text: "Comparing prices", done: 8, total: 12 } }), task("T2", "Flights", "done")],
  board: { version: 0, facts: {}, claims: {} },
};
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/duet")) {
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/duet/open") return route.fulfill({ json: { threadId: "50" } });
      if (url.pathname === "/api/duet/message") {
        const target = data.tasks.find((t) => t.id === body.taskId);
        data = { ...data, messages: [...data.messages, { id: String(data.messages.length + 10), from: "owner", kind: "message", text: body.text, taskId: body.taskId || "", label: target?.label || "", quote: "" }] };
        return route.fulfill({ json: { threadId: "50", delivered: body.taskId ? "steer" : "front desk" } });
      }
      if (url.pathname === "/api/duet/stop") {
        data = { ...data, tasks: data.tasks.map((t) => (t.id === body.taskId ? { ...t, state: "stopped", running: false } : t)) };
        return route.fulfill({ json: { taskId: body.taskId, state: "stopped" } });
      }
    }
    return route.fulfill({ json: data });
  }
  if (url.pathname === "/api/state")
    return route.fulfill({ json: {
      runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
      auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }],
      view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
    } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
const shots = process.env.MARS_DUET_SHOTS;
const checks = [];
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.getByRole("button", { name: "Duet", exact: true }).first().click();
  const duet = page.locator(".duet");
  await duet.getByText("QF25").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("view"), "duet");
  assert.equal(await page.locator(".live-header-title").innerText(), "Duet");
  checks.push("sidebar entry opens Duet at ?view=duet");

  const owner = duet.locator('.duet-row[data-from="owner"] .duet-bubble').first();
  const reply = duet.locator('.duet-row[data-from="duet"] .duet-bubble').first();
  assert.equal(await owner.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(68, 67, 63)", "owner bubbles are the lighter grey");
  assert.equal(await reply.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(181, 85, 47)", "Duet bubbles are orange");
  const ownerBox = await owner.boundingBox();
  const replyBox = await reply.boundingBox();
  assert.ok(ownerBox.x > replyBox.x, "the owner is on the right, Duet on the left");
  const result = duet.locator(".duet-row", { hasText: "QF25" });
  assert.match(await result.innerText(), /Flights · T2[\s\S]*a Friday flight[\s\S]*QF25/);
  assert.equal(await result.locator("a").getAttribute("target"), "_blank");
  assert.match(await duet.locator(".duet-system").allInnerTexts().then((t) => t.join("|")), /Started Hotels · T1\|Started Flights · T2\|Hotels to Flights: What time do you land\?/);
  checks.push("bubbles, labels, quote, markdown link, system lines");
  if (shots) await page.screenshot({ path: shots + "/duet-desktop.png" });

  const strip = duet.getByRole("button", { name: /1 working/ });
  await strip.click();
  const hotels = duet.locator(".duet-task", { hasText: "Hotels" });
  assert.match(await hotels.innerText(), /Working · Comparing prices \(8 of 12\)/);
  assert.match(await duet.locator(".duet-task", { hasText: "Flights" }).innerText(), /Done/);
  checks.push("task strip lists tasks with state words and progress");
  if (shots) await page.screenshot({ path: shots + "/duet-tasks.png" });

  await result.hover();
  await result.getByRole("button", { name: "Reply to Flights" }).click();
  assert.match(await duet.locator(".duet-target").innerText(), /Replying to Flights · T2/);
  const box = duet.getByRole("textbox", { name: "Message Flights" });
  await box.fill("Only morning flights please");
  await box.press("Enter");
  await duet.locator(".duet-row", { hasText: "Only morning flights please" }).waitFor();
  const steer = posts.find((p) => p.path === "/api/duet/message");
  assert.equal(steer.body.text, "Only morning flights please");
  assert.equal(steer.body.taskId, "T2");
  assert.match(await duet.locator(".duet-row", { hasText: "Only morning flights please" }).innerText(), /To Flights · T2/);
  checks.push("reply to a task sends its id");

  await duet.getByRole("button", { name: "Stop replying to this task" }).click();
  const plain = duet.getByRole("textbox", { name: "Message Duet" });
  await plain.fill("Also remind me to pack");
  await plain.press("Enter");
  await duet.locator(".duet-row", { hasText: "Also remind me to pack" }).waitFor();
  const front = posts.filter((p) => p.path === "/api/duet/message").at(-1);
  assert.equal(front.body.taskId, undefined, "a plain message goes to the front desk");
  checks.push("plain message goes to the front desk");

  await hotels.getByRole("button", { name: "Stop Hotels" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".duet-task")].some((row) => row.textContent.includes("Hotels") && row.textContent.includes("Stopped")));
  assert.deepEqual(posts.filter((p) => p.path === "/api/duet/stop").at(-1).body, { taskId: "T1" });
  checks.push("stop one task");

  data = { ...data, running: true };
  await duet.getByLabel("Duet is typing").waitFor();
  checks.push("typing indicator while the front desk answers");

  await page.setViewportSize({ width: 390, height: 844 });
  await duet.getByText("QF25").waitFor();
  const wide = await duet.locator(".duet-row", { hasText: "QF25" }).locator(".duet-line").boundingBox();
  assert.ok(wide.width <= 390 * 0.9, "bubbles fit a phone");
  if (shots) await page.screenshot({ path: shots + "/duet-phone.png" });
  checks.push("phone width");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  if (shots) await page.screenshot({ path: shots + "/duet-failure.png" }).catch(() => {});
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.message || error).slice(0, 800) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
