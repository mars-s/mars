// "Compact now" (docs/LIVE-INTEGRATION.md "Compaction"), against routed fixtures: a click shows
// "Compacting" at once and keeps it while the host reports the compaction running, then says it is
// done; a failure offers "Try again". Duet is parked: no Duet in the sidebar unless the host
// turns it on (docs/DUET.md "Parked").
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const host = { compaction: { running: false }, duet: false, compacts: 0 };
const state = () => ({
  runtime: "Pi Durable 1.3.0", conversationId: "1", selectedConversationId: "1",
  auth: { connected: true, state: "connected", events: [] }, providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: "1", title: "Main" }],
  duet: host.duet, compaction: host.compaction,
  context: { basis: "reported", limit: 1000000, used: 893000, compactAt: 0.98, autoCompact: true, segments: [{ id: "messages", label: "Messages", tokens: 893000 }] },
  view: { entries: [{ id: 1, model: [{ role: "user", content: "hello" }] }, { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] }], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
});
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/state") return route.fulfill({ json: state() });
  if (url.pathname === "/api/compact") {
    host.compacts++;
    // The host admits the task; it shows in the next poll or two.
    setTimeout(() => { host.compaction = { running: true }; }, 1500);
    return route.fulfill({ status: 202, json: { taskId: 7 } });
  }
  return route.fulfill({ json: { conversations: [{ id: "1", title: "Main" }], rootId: "1" } });
});
const checks = [];
const trigger = page.locator(".mars-context-trigger");
const panel = page.locator(".mars-context-panel");
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await trigger.waitFor();
  assert.equal(await page.locator(".live-sidebar").getByText("Duet", { exact: true }).count(), 0, "Duet is parked");
  checks.push("no Duet while parked");

  await trigger.click();
  await panel.getByRole("button", { name: "Compact now" }).click();
  await panel.getByRole("button", { name: "Compacting…" }).waitFor({ timeout: 1000 });
  assert.equal(await panel.getByRole("button", { name: "Compacting…" }).isDisabled(), true, "no second click");
  assert.match(await panel.innerText(), /takes a minute or so/);
  assert.match(await trigger.innerText(), /Compacting/);
  assert.equal(host.compacts, 1);
  checks.push("a click shows Compacting at once");

  await page.waitForTimeout(3000);
  assert.match(await trigger.innerText(), /Compacting/, "still compacting while the host reports it");
  host.compaction = { running: false };
  await panel.getByText("Compacted. Older turns are now a summary.").waitFor({ timeout: 4000 });
  await panel.getByRole("button", { name: "Compact now" }).waitFor();
  checks.push("done is said when it finishes");

  host.compaction = { running: false, failure: "The summary model failed" };
  await panel.getByRole("button", { name: "Try again" }).waitFor({ timeout: 12000 });
  assert.match(await panel.innerText(), /The last compaction failed: The summary model failed/);
  checks.push("a failure offers Try again");

  host.duet = true;
  await page.locator(".live-sidebar").getByText("Duet", { exact: true }).waitFor({ timeout: 4000 });
  checks.push("Duet shows when the host turns it on");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
