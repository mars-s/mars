import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForComposer, waitForHydration } from "./browser-options.mjs";

// Cross-surface layout guards from the UI sweep, against the running preview and its fixture host:
// no sideways scroll at 390px on any surface (document or body), no browser errors, and the model
// name stays readable in the composer beside an open workbench.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/ui-sweep";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];

async function open(path, viewport, theme = "dark") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addInitScript((value) => {
    if (window === window.top) localStorage.setItem("mars-live-theme", value);
    localStorage.removeItem("mars-workbench-v1");
  }, theme);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${path}: ${message.text()}`);
  });
  await page.goto(new URL(path, uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
  // The page settles once the conversation has loaded; a click before that can be lost.
  if (!path.startsWith("/design-system")) {
    await waitForHydration(page);
    await waitForComposer(page);
  }
  else await page.getByRole("heading", { name: "Mars design system" }).waitFor({ timeout: 120000 });
  return page;
}
const sideways = (page) =>
  page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
const workbench = (page) => page.getByRole("region", { name: "Workbench" });

try {
  const phone = { width: 390, height: 844 };
  const surfaces = [
    ["/?conversation=1", "chat"],
    ["/?conversation=2", "empty chat"],
    ["/?conversation=8", "side chat"],
    ["/design-system", "design system"],
  ];
  for (const theme of ["dark", "light"])
    for (const [path, name] of surfaces) {
      const page = await open(path, phone, theme);
      assert.equal(await sideways(page), 0, `${name} (${theme}) does not scroll sideways at 390px`);
      // Playwright hides the caret for a screenshot by styling every input. Taken before React
      // has hydrated the page, that style reads as a hydration mismatch, so wait first.
      if (path.startsWith("/design-system")) {
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll(".ds-page textarea, .ds-page input")];
          return inputs.length > 0 && inputs.every((input) => Object.keys(input).some((key) => key.startsWith("__reactProps")));
        }, null, { timeout: 60000 });
        await page.screenshot({ path: `${evidence}/phone-${theme}-design-system.png`, fullPage: true, caret: "initial" });
      }
      await page.context().close();
    }

  const phonePanes = await open("/?conversation=1", phone, "light");
  await phonePanes.getByRole("button", { name: "Open workbench" }).click();
  for (const tool of ["Changes", "Files", "Terminal", "Side chat", "Pages", "Browser"]) {
    await workbench(phonePanes).getByRole("button", { name: "New workbench tab" }).click();
    await workbench(phonePanes).getByRole("button", { name: new RegExp(`^${tool}`) }).first().click();
    await phonePanes.waitForTimeout(800);
    assert.equal(await sideways(phonePanes), 0, `${tool} pane does not scroll sideways at 390px`);
  }
  await phonePanes.context().close();

  // At 1024px the composer shares the row with the 360px pane; the effort label gives way first.
  const narrow = await open("/?conversation=1", { width: 1024, height: 768 });
  await narrow.getByRole("button", { name: "Open workbench" }).click();
  await workbench(narrow).waitFor();
  const name = narrow.locator(".mars-model-trigger-name");
  const [scrollWidth, clientWidth] = await name.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  assert.ok(scrollWidth <= clientWidth + 1, `the model name is not cut off beside the pane (${clientWidth}px of ${scrollWidth}px shown)`);
  await narrow.locator(".live-composer").screenshot({ path: `${evidence}/narrow-composer.png` });
  await narrow.context().close();

  assert.deepEqual(errors, []);
  console.log("PASS UI sweep: no sideways scroll at 390px on chat, side chat, design system and every workbench pane in both themes, readable model name beside the pane at 1024px, no browser errors");
} finally {
  await browser.close();
}
