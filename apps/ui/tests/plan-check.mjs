import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

// The agent's checklist (plan_update) in the thread, against the preview fixture:
// conversation 1 has a plan in progress, conversation 7 a finished one.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/plan";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
async function open(path, viewport, theme) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(path, uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  return page;
}
try {
  const page = await open("/?conversation=1", { width: 1440, height: 900 }, "dark");
  const plan = page.getByRole("region", { name: "Plan" });
  await plan.waitFor();
  const items = plan.getByRole("listitem");
  assert.equal(await items.count(), 4);
  assert.deepEqual(await items.evaluateAll((rows) => rows.map((row) => row.dataset.status)), ["completed", "in_progress", "pending", "pending"]);
  assert.equal(await items.nth(1).locator(".live-plan-mark").evaluate((mark) => getComputedStyle(mark).animationName), "none", "reduced motion stills the spinner");
  assert.match(await items.nth(0).textContent(), /done$/, "status is spoken for screen readers");
  await plan.screenshot({ path: `${evidence}/desktop-dark-in-progress.png` });
  await page.screenshot({ path: `${evidence}/desktop-dark-thread.png` });
  // Each page polls the host every second; close finished ones so a slow machine keeps up.
  await page.context().close();

  // A finished plan collapses to its count and opens on click.
  const done = await open("/?conversation=7", { width: 1440, height: 900 }, "light");
  const summary = done.getByRole("button", { name: /Plan: 2 of 2 done/ });
  await summary.waitFor();
  assert.equal(await done.getByRole("region", { name: "Plan" }).getByRole("listitem").count(), 0, "collapsed when finished");
  await summary.click();
  assert.equal(await done.getByRole("region", { name: "Plan" }).getByRole("listitem").count(), 2);
  await done.screenshot({ path: `${evidence}/desktop-light-finished.png` });
  await done.context().close();

  // No plan, no card.
  const none = await open("/?conversation=3", { width: 1440, height: 900 }, "dark");
  await none.waitForTimeout(500);
  assert.equal(await none.getByRole("region", { name: "Plan" }).count(), 0);
  await none.context().close();

  const phone = await open("/?conversation=1", { width: 390, height: 844 }, "dark");
  await phone.getByRole("region", { name: "Plan" }).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no overflow at 390px");
  await phone.screenshot({ path: `${evidence}/mobile-dark.png` });
  assert.deepEqual(errors, []);
  console.log("PASS plan card: four steps with done, in-progress and pending states, spoken status, reduced motion, finished plan collapses and opens, no plan no card, 390px without overflow");
} finally {
  await browser.close();
}
