import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, composerText, waitForComposer } from "./browser-options.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/conversations-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
const conversations = [
  { id: 1, title: "First conversation", running: true },
  { id: 2, title: "Second conversation" },
];
let pauseRoot = false;
let heldRoot;
let releaseRoot;
const held = new Promise((resolve) => {
  heldRoot = resolve;
});
const release = new Promise((resolve) => {
  releaseRoot = resolve;
});
let running = false;
let workerRunning = true;
function state(id) {
  return {
    runtime: "Pi Durable 1.3.0",
    conversationId: id,
    selectedConversationId: id,
    auth: { connected: true, state: "connected", events: [] },
    providerReady: true,
    models: [
      { id: "gpt-6-luna", name: "Luna" },
      { id: "gpt-6-sol", name: "Sol" },
    ],
    extensions: [],
    conversations,
    workers:
      id === 2
        ? [
            {
              id: 22,
              conversationId: 2,
              modelId: "gpt-6-sol",
              status: workerRunning ? "running" : "aborted",
            },
          ]
        : [],
    usage: {
      models: { "openai/gpt-6-luna": { input: 100, output: 20, totalTokens: 120 } },
      tools: {},
    },
    view: {
      entries:
        id === 3
          ? []
          : [
              {
                id,
                model: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: `History for conversation ${id}` }],
                  },
                ],
              },
            ],
      docs: {
        "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } },
        "pi.live": id === 2 && running ? { run: { taskId: 50 } } : {},
      },
    },
  };
}
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") {
    const id = Number(url.searchParams.get("conversationId") || 1);
    if (id === 1 && pauseRoot) {
      pauseRoot = false;
      heldRoot();
      await release;
    }
    return route.fulfill({ json: state(id) });
  }
  if (url.pathname === "/api/conversations" && request.method() === "GET")
    return route.fulfill({ json: { conversations, rootId: 1 } });
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/conversations") {
    conversations.push({ id: 3, title: "New conversation" });
    return route.fulfill({
      status: 201,
      json: { conversation: { id: 3, title: "New conversation" } },
    });
  }
  if (url.pathname === "/api/chat") running = true;
  if (url.pathname === "/api/abort") running = false;
  if (url.pathname === "/api/workers/stop") workerRunning = false;
  return route.fulfill({ status: 202, json: { accepted: true } });
});
try {
  await page.goto(uiBaseURL(), {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await page.getByText("History for conversation 1", { exact: true }).waitFor();
  await waitForComposer(page);
  const input = page.getByRole("textbox", { name: "Message Mars" });
  await input.fill("Draft belonging to first conversation");
  pauseRoot = true;
  await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error("Root poll did not start")), 15000))]);
  await page.getByRole("button", { name: "Second conversation", exact: true }).click();
  await page.getByText("History for conversation 2", { exact: true }).waitFor();
  assert.equal(await composerText(input), "");
  releaseRoot();
  await page.waitForTimeout(1200);
  assert.equal(await page.getByText("History for conversation 1", { exact: true }).count(), 0);
  assert.equal(requests.filter((request) => request.path === "/api/abort").length, 0);
  await input.fill("Draft belonging to second conversation");
  await page.getByRole("button", { name: /^First conversation\b/ }).click();
  await page.getByText("History for conversation 1", { exact: true }).waitFor();
  assert.equal(await composerText(input), "Draft belonging to first conversation");
  await page.getByRole("button", { name: "Second conversation", exact: true }).click();
  await page.getByText("History for conversation 2", { exact: true }).waitFor();
  assert.equal(await composerText(input), "Draft belonging to second conversation");
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("menuitemradio", { name: "Sol", exact: true }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Message Mars"]').disabled);
  assert.equal(requests.find((request) => request.path === "/api/model").body.conversationId, "2");
  await page.locator(".live-workers > summary").click();
  await page.getByRole("button", { name: "Stop worker 22" }).click();
  assert.deepEqual(requests.find((request) => request.path === "/api/workers/stop").body, {
    conversationId: "2",
    workerId: "22",
  });
  await page.getByText("aborted", { exact: true }).waitFor();
  assert.equal(await page.getByText("120", { exact: true }).count(), 1);
  await input.fill("Message to second conversation");
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop response" }).waitFor();
  assert.equal(requests.find((request) => request.path === "/api/chat").body.conversationId, "2");
  await page.getByRole("button", { name: "Stop response" }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(requests.find((request) => request.path === "/api/abort").body.conversationId, "2");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: "New conversation", exact: true }).waitFor();
  await page.getByRole("heading", { name: "What shall we work on?" }).waitFor();
  assert.equal(await composerText(input), "");
  assert.equal(await page.getByText("History for conversation 2", { exact: true }).count(), 0);
  assert.equal(requests.filter((request) => request.path === "/api/conversations").length, 1);
  await input.fill("Third conversation draft");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^First conversation\b/ })
    .click();
  await page.getByText("History for conversation 1", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    mode: "browser-only fixtures",
    checks: [
      "new conversation acknowledged once",
      "selection replaces history",
      "stale poll discarded",
      "switch never aborts",
      "drafts isolated and restored",
      "model/chat/abort scoped",
      "worker cancellation scoped",
      "native usage displayed",
      "mobile conversation selection",
    ],
  };
  await writeFile(`${evidence}/conversations-browser-check.json`, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  releaseRoot();
  await browser.close();
}
