// Updates in the web UI (docs/UPDATES.md), against the preview fixture: the sidebar says an
// update is available and opens Settings, Updates; the panel lists the new commits; Update
// now shows each step and then the result; conflicts list their files and offer no button;
// the automatic switch posts its value; no overflow at 390px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/updates-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const reset = (page, body = {}) => page.evaluate((value) => fetch("/api/update/fixture-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), body);
try {
  for (const [name, viewport, theme] of [["desktop-dark", { width: 1440, height: 900 }, "dark"], ["mobile-light", { width: 390, height: 844 }, "light"]]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(new URL("/?conversation=1", uiBaseURL()).href);
    await page.evaluate((value) => localStorage.setItem("mars-live-theme", value), theme);
    await reset(page);
    await page.reload();
    await waitForHydration(page);

    if (viewport.width < 700) await page.getByRole("button", { name: "Open navigation" }).click();
    const account = page.getByRole("button", { name: "Open settings" }).last();
    await account.locator("small", { hasText: "Update available" }).waitFor();
    await account.click();
    assert.equal(await page.getByRole("tab", { name: "Updates", exact: true }).getAttribute("aria-selected"), "true", "the notice opens Settings, Updates");
    const panel = page.locator(".update-settings");
    await panel.getByText("2 new commits on main.").waitFor();
    for (const text of ["Fixture: tidy the composer toolbar", "Fixture: faster gateway reconnect", "c1787bd53fc8", "Install updates automatically"])
      assert.ok(await panel.getByText(text, { exact: false }).first().isVisible(), `${name}: shows ${text}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".update-settings *")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && !["SPAN", "STRONG", "BUTTON", "CODE", "TIME", "SMALL"].includes(el.tagName)));
    assert.equal(overflow, false, `${name}: nothing overflows`);
    await page.screenshot({ path: `${evidence}/${name}-available.png` });

    if (name === "desktop-dark") {
      let posted = null;
      await page.route("**/api/update/settings", async (route) => { posted = route.request().postDataJSON(); await route.continue(); });
      await panel.getByRole("switch", { name: "Install updates automatically" }).click();
      await page.waitForFunction(() => document.querySelector('.update-settings [role="switch"]')?.getAttribute("aria-checked") === "true");
      assert.deepEqual(posted, { auto: true }, "the switch posts its value");

      await panel.getByRole("button", { name: "Update now" }).click();
      await panel.getByText(/Building the new version/).waitFor();
      await panel.getByRole("list", { name: "Update progress" }).waitFor();
      await panel.getByText("Build the interface").waitFor();
      await page.screenshot({ path: `${evidence}/${name}-progress.png` });
      await panel.getByText("Mars is up to date.").waitFor({ timeout: 20000 });
      await panel.getByText("Updated.", { exact: true }).waitFor();
      assert.ok(await panel.getByText("c1787bd53fc8 → 9a41e02b7c10").isVisible(), "the last update names both commits");
      assert.equal(await panel.getByRole("button", { name: "Update now" }).count(), 0, "nothing left to install");
      assert.equal(await panel.getByText(/Building the new version/).count(), 0, "the building notice is gone once the result is in");
      await page.screenshot({ path: `${evidence}/${name}-updated.png` });

      await reset(page, { state: "needs_reconcile" });
      await panel.getByRole("button", { name: "Check now" }).click();
      await panel.getByText("main has changes that conflict with this copy.").waitFor();
      const heading = await panel.locator(".update-state h3").evaluate((el) => getComputedStyle(el).color);
      const body = await panel.locator(".update-state p").evaluate((el) => getComputedStyle(el).color);
      assert.notEqual(heading, body, "a conflict heading is coloured as a warning");
      // The open dialog hides the sidebar from the accessibility tree, so read it by class.
      await page.locator(".live-account small", { hasText: "Model ready" }).waitFor({ timeout: 5000 });
      assert.equal(await page.locator(".live-account small[data-update]").count(), 0, "a conflict is not advertised as an available update");
      assert.ok(await panel.getByText("apps/ui/components/composer/composer.tsx").isVisible(), "the conflicting file is listed");
      assert.ok(await panel.getByText(/Ask Mars in a chat to reconcile/).isVisible());
      assert.equal(await panel.getByRole("button", { name: "Update now" }).count(), 0, "no install button for a conflict");
      await page.screenshot({ path: `${evidence}/${name}-conflict.png` });
    }
    await page.close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS updates UI: sidebar notice opens Settings, Updates; new commits listed; Update now shows steps then the result; conflicts list files with no install button; auto switch posts; no overflow at 390px light");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
