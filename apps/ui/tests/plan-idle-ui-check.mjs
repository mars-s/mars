// The plan card's spinner turns only while the agent works (routed fixtures): a step left in
// progress when the reply ended shows still and is read as "started, not finished".
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let running = true;
const plan = { steps: [{ step: "Build it", status: "completed" }, { step: "Ship it", status: "in_progress" }], done: 1, total: 2, next: "Ship it" };
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/state")
    return route.fulfill({ json: {
      runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1, plan,
      auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }],
      view: { entries: [{ id: 1, model: [{ role: "user", content: "go" }] }], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } }, "pi.live": running ? { run: { taskId: 3 } } : {} } },
    } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const mark = page.getByRole("region", { name: "Plan" }).getByRole("listitem").nth(1).locator(".live-plan-mark");
  await mark.waitFor();
  assert.equal(await mark.evaluate((el) => getComputedStyle(el).animationName), "live-plan-spin", "spins while working");
  checks.push("spinner while working");
  running = false;
  await page.waitForFunction(() => document.querySelector(".live-plan")?.hasAttribute("data-idle"), null, { timeout: 15000 });
  assert.equal(await mark.evaluate((el) => getComputedStyle(el).animationName), "none", "still once the reply ended");
  assert.match(await page.getByRole("region", { name: "Plan" }).getByRole("listitem").nth(1).textContent(), /started, not finished/);
  checks.push("still and read as not finished when idle");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.message || error).slice(0, 500) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
