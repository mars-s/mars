// The Skills list on the Extensions page, against routed fixtures: names with /, sources,
// search, and the empty state.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let skills = [
  { name: "grill-me", description: "Use when the owner wants to be interviewed about a plan.", source: "agents" },
  { name: "release-notes", description: "Use when writing release notes.", source: "mars" },
];
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/skills") return route.fulfill({ json: { total: skills.length, skills } });
  if (url.pathname === "/api/plugins") return route.fulfill({ json: { plugins: [] } });
  if (url.pathname === "/api/state")
    return route.fulfill({ json: { runtime: "Pi Durable 1.3.0", conversationId: 1, auth: { connected: true, state: "connected", events: [] }, providerReady: true, models: [], extensions: [], conversations: [{ id: 1, title: "Main" }], view: { entries: [], docs: {} } } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.locator(".live-sidebar").getByRole("button", { name: /^Extensions/ }).click();
  const section = page.getByRole("region", { name: "Skills" });
  await section.getByText("/grill-me").waitFor();
  assert.equal(await section.getByText("~/.agents").count(), 1);
  assert.equal(await section.getByText("Mars", { exact: true }).count(), 1);
  await section.getByRole("searchbox", { name: "Search skills" }).fill("release");
  await section.getByText("/grill-me").waitFor({ state: "detached" });
  await section.getByText("/release-notes").waitFor();
  await section.getByRole("searchbox", { name: "Search skills" }).fill("zzz");
  await section.getByText("No skills match").waitFor();
  skills = [];
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.locator(".live-sidebar").getByRole("button", { name: /^Extensions/ }).click();
  await page.getByText("No skills yet.", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["names and sources", "search", "no match", "empty state"] }));
} finally {
  await browser.close();
}
