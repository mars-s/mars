// Queue and steer in the browser against routed fixtures: while a reply runs, Enter queues
// (mode "queue"), the queue replaces the "is working" line, Steer and remove act on Pi's
// inbox by submission id, the bottom Steer button sends with mode "steer", and an idle send
// carries no mode.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { browserLaunchOptions, uiBaseURL, waitForHydration, composerText, waitForComposer } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/queue-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
let running = true;
let inbox = [];
let nextId = 50;
const state = () => ({
  runtime: "Pi Durable 1.3.0",
  conversationId: 1,
  selectedConversationId: 1,
  auth: { connected: true, state: "connected", events: [] },
  providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna", provider: "openai" }],
  extensions: [],
  conversations: [{ id: 1, title: "Main conversation" }],
  workers: [],
  view: {
    entries: [{ id: 1, model: [{ role: "user", content: "Deploy the host" }] }],
    docs: {
      "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } },
      "pi.live": running ? { run: { taskId: 3 } } : {},
      "pi.inbox": { items: inbox },
    },
  },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state() });
  if (request.method() !== "POST") return route.fulfill({ json: { conversations: [{ id: 1, title: "Main conversation" }], rootId: 1 } });
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/chat") {
    if (running) inbox.push({ id: nextId++, mode: body.mode === "steer" ? "steer" : "followUp", content: [{ type: "text", text: body.text }] });
    return route.fulfill({ status: 202, json: { submissionId: String(nextId) } });
  }
  if (url.pathname === "/api/queue/steer") {
    inbox = inbox.map((item) => (String(item.id) === body.submissionId ? { ...item, mode: "steer" } : item));
    return route.fulfill({ json: { steered: true } });
  }
  if (url.pathname === "/api/queue/remove") {
    inbox = inbox.filter((item) => String(item.id) !== body.submissionId);
    return route.fulfill({ json: { removed: true } });
  }
  if (url.pathname === "/api/abort") running = false;
  return route.fulfill({ json: { ok: true } });
});
const chats = () => requests.filter((request) => request.path === "/api/chat").map((request) => request.body);
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await waitForComposer(page);
  const input = page.getByRole("textbox", { name: "Message Mars" });
  await page.getByText("Luna is working. New messages wait in a queue.").waitFor();

  // Enter queues while the reply runs, and the composer clears.
  await input.fill("Use the blue button");
  await input.press("Enter");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await queue.getByText("Use the blue button").waitFor();
  assert.equal(chats().at(-1).mode, "queue");
  assert.equal(chats().at(-1).conversationId, "1");
  assert.equal(await composerText(input), "");
  assert.equal(await page.getByText("Luna is working.", { exact: false }).count(), 0, "the queue replaces the working line");
  await input.fill("Then write it up");
  await page.getByRole("button", { name: "Queue message" }).click();
  await queue.getByText("Then write it up").waitFor();
  await queue.getByText("2 messages waiting for Luna").waitFor();
  await page.screenshot({ path: `${evidence}/queued.png` });

  // Steer one, remove the other.
  await queue.getByRole("button", { name: "Steer now: Use the blue button" }).click();
  await queue.getByText("Steering, after the current step").waitFor();
  assert.deepEqual(requests.find((request) => request.path === "/api/queue/steer").body, { submissionId: "50", conversationId: "1" });
  await queue.getByRole("button", { name: "Remove from queue: Then write it up" }).click();
  await queue.getByText("Then write it up").waitFor({ state: "detached" });
  assert.deepEqual(requests.find((request) => request.path === "/api/queue/remove").body, { submissionId: "51", conversationId: "1" });

  // The bottom Steer button sends straight into the running reply.
  await input.fill("Stop using port 80");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await queue.getByText("Stop using port 80").waitFor();
  assert.equal(chats().at(-1).mode, "steer");
  await page.screenshot({ path: `${evidence}/steering.png` });

  // Stop, then an idle send carries no mode.
  await page.getByRole("button", { name: "Stop response" }).click();
  inbox = [];
  await page.getByText("Luna on Pi").waitFor();
  await input.fill("Fresh question");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent === "");
  assert.equal(chats().at(-1).text, "Fresh question");
  assert.equal("mode" in chats().at(-1), false, "an idle send starts a reply as before");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  const result = { passed: true, mode: "browser-only fixtures", checks: ["Enter queues while running", "composer clears", "queue replaces working line", "queue button", "Steer by id", "remove by id", "bottom Steer sends mode steer", "idle send has no mode", "390px no overflow"] };
  await writeFile(`${evidence}/queue-browser-check.json`, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
