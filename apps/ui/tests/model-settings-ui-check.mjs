// Models settings and background summaries in the browser, against routed fixtures: choosing
// a default model and effort and a background model saves to the host, a new chat then lets the
// host pick the default, and a written summary titles its activity group with the counts kept.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
let settings = { defaultModel: "", defaultEffort: "", backgroundModel: "" };
const tool = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "npm test " + id } }] });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
const state = () => ({
  runtime: "Pi Durable 1.3.0",
  conversationId: 1,
  auth: { connected: true, state: "connected", events: [] },
  providerReady: true,
  models: [
    { id: "gpt-6-luna", name: "Luna", provider: "openai", efforts: ["low", "medium", "high"] },
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", efforts: ["low", "medium", "high", "max"] },
    { id: "opencode-go/kimi", name: "OpenCode Go · Kimi", provider: "opencode-go", efforts: [] },
  ],
  extensions: [],
  conversations: [{ id: 1, title: "Main" }],
  modelSettings: settings,
  summaries: { "2:0": "Ran the whole test suite" },
  view: {
    entries: [
      { id: 1, model: [{ role: "user", content: "Run the tests" }] },
      { id: 2, model: [tool("a"), result("a")] },
      { id: 3, model: [tool("b"), result("b")] },
      { id: 4, model: [tool("c"), result("c"), { role: "assistant", content: [{ type: "text", text: "All green." }] }] },
    ],
    docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } },
  },
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state() });
  if (request.method() !== "POST") return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/settings/models") {
    settings = { ...settings, ...body };
    return route.fulfill({ json: settings });
  }
  if (url.pathname === "/api/conversations") return route.fulfill({ status: 201, json: { conversation: { id: 1, title: "Main" } } });
  return route.fulfill({ json: { ok: true } });
});
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  // The summary titles the group; the counts stay beside it.
  await page.getByText("Ran the whole test suite", { exact: true }).waitFor();
  await page.locator(".live-activity small").getByText("Ran 3 commands").waitFor();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByLabel("Default model").selectOption("anthropic/claude-opus-5-5");
  await page.getByLabel("Default effort").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/settings/models", body: { defaultModel: "anthropic/claude-opus-5-5" } });
  await page.getByLabel("Default effort").selectOption("high");
  assert.deepEqual(requests.at(-1).body, { defaultEffort: "high" });
  await page.getByLabel("Background model").selectOption("opencode-go/kimi");
  assert.deepEqual(requests.at(-1).body, { backgroundModel: "opencode-go/kimi" });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForFunction(() => true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(requests.find((request) => request.path === "/api/conversations").body, {}, "the host picks the default model");
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["summary titles the group with counts kept", "default model", "default effort", "background model", "new chat lets the host pick the default"] }));
} finally {
  await browser.close();
}
