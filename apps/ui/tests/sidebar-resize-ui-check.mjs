// The sidebar is resizable by its right edge, on by default: drag, keyboard, double-click to
// reset, the width kept across reloads, and no handle while collapsed. Routed fixtures only.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const conversations = [{ id: 1, title: "Main Mars Chat with a long title that needs room to show in full" }];
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/state")
    return route.fulfill({ json: {
      runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
      auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations,
      view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
    } });
  return route.fulfill({ json: { conversations, rootId: 1 } });
});
const sidebar = page.locator(".live-sidebar");
const handle = page.getByRole("separator", { name: "Resize sidebar" });
const width = async () => Math.round((await sidebar.boundingBox()).width);
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  // A new browser profile has no saved width.
  await handle.waitFor();
  assert.equal(await width(), 288, "starts at the default width");
  checks.push("on by default");

  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + 300;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  assert.equal(await sidebar.getAttribute("data-resizing"), "true", "marked while dragging");
  await page.mouse.move(x + 112, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await width(), 400, "follows the drag");
  assert.equal(await handle.getAttribute("aria-valuenow"), "400");
  checks.push("drag");

  await page.mouse.move(x + 112, y);
  await page.mouse.down();
  await page.mouse.move(x + 900, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await width(), 480, "no wider than the maximum");
  checks.push("clamped");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.waitForTimeout(500);
  assert.equal(await width(), 480, "kept after a reload");
  checks.push("kept");

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  assert.equal(await width(), 464, "arrow keys resize");
  await page.keyboard.press("Home");
  await page.waitForTimeout(300);
  assert.equal(await width(), 220, "Home goes to the minimum");
  checks.push("keyboard");

  await handle.dblclick();
  await page.waitForTimeout(400);
  assert.equal(await width(), 288, "double-click resets");
  checks.push("reset");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.waitForTimeout(400);
  assert.equal(await handle.count(), 0, "no handle while collapsed");
  assert.equal(await width(), 56);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.waitForTimeout(400);
  assert.equal(await width(), 288, "expands back to the saved width");
  checks.push("collapse");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
