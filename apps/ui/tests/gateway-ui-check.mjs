// Gateway in the web UI (docs/GATEWAY.md), against the preview fixture: the Telegram badge
// on a Recents row, Settings, Gateway with adapters, a pending pairing, linked chats and
// activity; approving a pairing; opening a linked chat; no overflow at 390px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/gateway-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
try {
  for (const [name, viewport, theme] of [["desktop-dark", { width: 1440, height: 900 }, "dark"], ["mobile-light", { width: 390, height: 844 }, "light"]]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    let approved = null;
    await page.route("**/api/gateway/pairings", async (route) => {
      approved = route.request().postDataJSON();
      await route.continue();
    });
    await page.goto(new URL("/?conversation=1", uiBaseURL()).href);
    await page.evaluate((value) => localStorage.setItem("mars-live-theme", value), theme);
    await page.evaluate(() => fetch("/api/gateway/fixture-reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    await page.reload();
    await waitForHydration(page);

    if (viewport.width > 700) {
      const row = page.locator(".live-conversation", { hasText: "Weekly reading list" });
      await row.locator('.live-channel-mark[data-channel="telegram"]').waitFor();
      assert.equal(await row.locator(".sr-only", { hasText: "From Telegram" }).count(), 1, "the badge is named for screen readers");
      assert.equal(await page.locator(".live-conversation", { hasText: "Tidy the Pi host deploy script" }).locator(".live-channel-mark").count(), 0, "web conversations have no badge");
    }

    await page.getByRole("button", { name: "Open settings" }).first().click();
    await page.getByRole("tab", { name: "Gateway", exact: true }).click();
    const panel = page.locator(".gateway-settings");
    await panel.getByText("Waiting for approval").waitFor();
    const detail = panel.getByText(/enable the Message Content intent/);
    assert.ok(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name}: a failure detail wraps instead of being cut off`);
    for (const text of ["Telegram", "@mars_fixture_bot", "Restarting after an error", "Weekly reading list", "Direct message 5550001", "Unknown sender, code sent", "K7QX2M9P"])
      assert.ok(await panel.getByText(text, { exact: false }).first().isVisible(), `shows ${text}`);
    assert.ok(await panel.getByText(/same power as you/).isVisible(), "approval warns about the power it grants");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".gateway-settings *")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && !["SPAN", "STRONG", "BUTTON", "CODE", "TIME"].includes(el.tagName)));
    assert.equal(overflow, false, `${name}: nothing overflows`);
    await page.screenshot({ path: `${evidence}/${name}-settings.png` });

    if (name === "desktop-dark") {
      await panel.getByRole("button", { name: "Approve" }).click();
      await page.waitForFunction(() => !document.querySelector(".gateway-pairings"));
      assert.deepEqual(approved, { code: "K7QX2M9P", approve: true }, "Approve posts the code");
      await panel.getByRole("button", { name: "Weekly reading list", exact: true }).click();
      await page.waitForURL(/conversation=3/);
      await page.getByText("Added. It is third on this week's list.").waitFor();
      await page.screenshot({ path: `${evidence}/${name}-opened-linked-chat.png` });
    }
    await page.close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS gateway UI: Telegram badge in Recents with spoken name, Settings Gateway shows adapters, failure detail, pending pairing with warning, linked chats and activity; Approve posts the code; a linked chat opens its conversation; no overflow at 390px light");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
