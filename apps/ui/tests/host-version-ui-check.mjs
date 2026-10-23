// Host version in the browser, against routed fixtures: an interrupted host update shows a
// notice that opens Settings, Connection, which lists the build and how far main is ahead; no
// notice when the last update was fine.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let version = {
  commit: "3b404f254e59aa", subject: "Terminal kill never hangs up", deployedAt: "2026-10-21T11:13:38Z", source: "deployed.json",
  repoHead: "ca754d07ffff", behind: 3, interrupted: true,
  latestDeploy: { id: "x", status: "interrupted", detail: "It stopped while staging; the live app was not changed.", at: "2026-10-21T12:00:00Z", commit: "e709326e" },
};
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/host/version") return route.fulfill({ json: version });
  if (url.pathname === "/api/state")
    return route.fulfill({ json: { runtime: "Pi Durable 1.3.0", conversationId: 1, auth: { connected: true, state: "connected", events: [] }, providerReady: true, models: [], extensions: [], conversations: [{ id: 1, title: "Main" }], view: { entries: [], docs: {} } } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.getByText("The last host update was interrupted. The host may be running an older build.").waitFor();
  await page.getByRole("button", { name: "Details" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("3b404f25").waitFor();
  await dialog.getByText("3 commits on main not deployed yet").waitFor();
  await dialog.getByText("It stopped while staging; the live app was not changed.", { exact: false }).waitFor();
  // A host_deploy that failed in staging changed nothing live: no notice.
  version = { ...version, latestDeploy: { id: "y", status: "staging_failed", detail: "Checks failed.", at: "2026-10-23T10:22:00Z", commit: "a746e440" } };
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.getByText("The last host update", { exact: false }).count(), 0, "no notice for a staging failure");
  version = { ...version, behind: 0, interrupted: false, latestDeploy: null };
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.getByText("The last host update", { exact: false }).count(), 0, "no notice when the last update was fine");
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await page.getByRole("tab", { name: "Connection" }).click();
  await page.getByRole("dialog").getByText("Up to date with main").waitFor();
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["interrupted notice", "details open connection", "build and behind", "no notice when fine", "up to date"] }));
} finally {
  await browser.close();
}
