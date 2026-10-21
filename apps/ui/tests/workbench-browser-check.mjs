import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

// Runs against the preview: the Next proxy forwards keyed browse paths to the fixture,
// whose labelled "Fixture web app" on port 4173 has root-relative CSS, JS, a fetch and
// a second page. No real service or provider is reached.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/workbench-browser";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];

async function open(viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce" });
  // Only the Mars window; the sandboxed frame has no storage at all.
  // Start from a clean layout once per context (not on reloads, which must restore it).
  await context.addInitScript(() => {
    if (window !== window.top || sessionStorage.getItem("wb-check-cleared")) return;
    sessionStorage.setItem("wb-check-cleared", "1");
    localStorage.removeItem("mars-workbench-v1");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  await page.getByRole("button", { name: "Open workbench" }).click();
  await page.getByRole("region", { name: "Workbench" }).waitFor();
  return page;
}

try {
  const page = await open({ width: 1440, height: 900 }, "dark");
  // Suggested lists the discovered service by title and port; selecting it opens it.
  const suggestion = page.getByRole("button", { name: /Fixture web app/ });
  await suggestion.waitFor();
  assert.match(await suggestion.textContent(), /localhost:4173/);
  await suggestion.click();

  const frameElement = page.locator("iframe.wb-browser-frame");
  await frameElement.waitFor();
  const sandbox = await frameElement.getAttribute("sandbox");
  assert.equal(sandbox, "allow-scripts allow-forms allow-popups");
  assert.ok(!sandbox.includes("allow-same-origin"), "the frame is never same-origin with Mars");
  const frame = page.frameLocator("iframe.wb-browser-frame");
  await frame.getByRole("heading", { name: "Hello from localhost:4173" }).waitFor();

  // Root-relative CSS and module JS loaded, and the page's root-relative fetch worked.
  await frame.getByText("Fetched /api/hello through the proxy (fixture data).").waitFor({ timeout: 10000 });
  const color = await frame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(color, "rgb(250, 249, 245)", "the stylesheet loaded through the proxy");
  assert.equal(await page.getByRole("textbox", { name: "Address" }).inputValue(), "localhost:4173");

  // The page cannot read Mars: its origin is opaque, so parent access throws and its
  // own fetch to the owner API is refused by the proxy (no cookie, no token).
  const probe = await frame.locator("body").evaluate(async () => {
    let parentRead = "blocked";
    try {
      parentRead = String(window.parent.document.title);
    } catch {
      parentRead = "blocked";
    }
    let api = 0;
    try {
      api = (await fetch(new URL("/api/state", "http://localhost:3200/").href, { credentials: "include" })).status;
    } catch {
      api = -1;
    }
    return { origin: window.origin, parentRead, api };
  });
  assert.equal(probe.origin, "null", "opaque origin");
  assert.equal(probe.parentRead, "blocked", "cannot read the Mars document");
  assert.ok(probe.api === -1 || probe.api === 403 || probe.api === 401, `owner API refused from the frame (got ${probe.api})`);
  await page.screenshot({ path: `${evidence}/desktop-dark.png` });

  // Link navigation inside the frame moves the address bar; Back and Forward work.
  await frame.getByRole("link", { name: "About this fixture" }).click();
  await frame.getByRole("heading", { name: "About" }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Address"]')?.value === "localhost:4173/about");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await frame.getByRole("heading", { name: "Hello from localhost:4173" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Address" }).inputValue(), "localhost:4173");
  await page.getByRole("button", { name: "Forward" }).click();
  await frame.getByRole("heading", { name: "About" }).waitFor();
  await page.getByRole("button", { name: "Reload" }).click();
  await frame.getByRole("heading", { name: "About" }).waitFor();

  // The address persists with the tab.
  await page.reload();
  await page.locator("iframe.wb-browser-frame").waitFor();
  await page.frameLocator("iframe.wb-browser-frame").getByRole("heading", { name: "About" }).waitFor();

  // External addresses never load in the pane.
  const address = page.getByRole("textbox", { name: "Address" });
  await address.fill("https://example.com/");
  await address.press("Enter");
  const out = page.getByRole("link", { name: "Open in a new tab" });
  await out.waitFor();
  assert.equal(await out.getAttribute("href"), "https://example.com/");
  assert.equal(await out.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await page.locator("iframe.wb-browser-frame").count(), 0);

  // An undiscovered port is refused by the host with its reason.
  await address.fill("localhost:9");
  await address.press("Enter");
  await page.getByRole("alert").filter({ hasText: "not a running local web service" }).waitFor();

  for (const [viewport, theme, name] of [
    [{ width: 1440, height: 900 }, "light", "desktop-light"],
    [{ width: 390, height: 844 }, "dark", "mobile-dark"],
    [{ width: 390, height: 844 }, "light", "mobile-light"],
  ]) {
    const shot = await open(viewport, theme);
    await shot.getByRole("button", { name: /Fixture web app/ }).click();
    await shot.frameLocator("iframe.wb-browser-frame").getByText("Fetched /api/hello", { exact: false }).waitFor({ timeout: 10000 });
    assert.equal(await shot.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
    await shot.screenshot({ path: `${evidence}/${name}.png` });
    await shot.context().close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS workbench browser pane: suggested service with port, sandboxed frame without allow-same-origin, root-relative CSS/JS/fetch through the keyed proxy, opaque origin cannot read Mars or its API, in-frame link updates address, back/forward/reload, persisted address, external URLs open outside, undiscovered port refused, desktop and 390px dark and light without overflow",
  );
} finally {
  await browser.close();
}
