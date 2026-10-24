// Settings, Gateway, Allowed senders (docs/GATEWAY.md "Access and pairing"), with routed
// fixtures: approved senders have Remove, which posts { channel, sender }; senders set on the
// host say where to take them out and have no Remove; the HTTP API owner is not listed;
// nothing overflows at 390px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/gateway-senders-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const fixture = () => ({
  adapters: [
    { channel: "api", state: "running", detail: "", failures: 0 },
    { channel: "telegram", state: "running", detail: "@mars_fixture_bot", failures: 0 },
    { channel: "discord", state: "running", detail: "mars-fixture", failures: 0 },
  ],
  bindings: [],
  pairings: [],
  allowed: { api: ["owner"], telegram: ["6660002"], discord: ["400000000000000001"] },
  owners: { api: ["owner"], telegram: ["6660001"], discord: ["400000000000000001"] },
  outbox: 0,
  audit: [],
  available: { api: true, telegram: true, discord: true },
});
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    const state = fixture();
    const removed = [];
    await page.route("**/api/gateway", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) }));
    await page.route("**/api/gateway/allow/delete", async (route) => {
      const body = route.request().postDataJSON();
      removed.push(body);
      const list = state.allowed[body.channel] ?? [];
      const was = list.includes(body.sender);
      state.allowed[body.channel] = list.filter((id) => id !== body.sender);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, removed: was, configured: (state.owners[body.channel] ?? []).includes(body.sender) }) });
    });
    await page.goto(uiBaseURL());
    await waitForHydration(page);
    await page.getByRole("button", { name: "Open settings" }).first().click();
    await page.getByRole("tab", { name: "Gateway", exact: true }).click();
    const section = page.locator('section[aria-labelledby="gateway-senders-heading"]');
    await section.getByText("Allowed senders").waitFor();
    const row = (text) => section.locator(".gateway-row", { hasText: text });
    assert.equal(await section.locator(".gateway-row").count(), 3, "three senders; the HTTP API owner is not listed");
    assert.ok(await row("Telegram sender 6660001").getByText("Set on the host (MARS_TELEGRAM_OWNER). To remove it, take it out there and restart Mars.").isVisible(), "a configured owner says where to remove it");
    assert.equal(await row("Telegram sender 6660001").getByRole("button").count(), 0, "and has no Remove");
    assert.ok(await row("Discord sender 400000000000000001").getByText("Approved, and set on the host (MARS_DISCORD_OWNER)").isVisible());
    assert.ok(await row("Telegram sender 6660002").getByText("Approved", { exact: true }).isVisible());
    assert.ok(await section.getByText(/same power as you/).isVisible(), "the section says what an allowed sender can do");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('section[aria-labelledby="gateway-senders-heading"] *')].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && !["SPAN", "STRONG", "BUTTON", "CODE"].includes(el.tagName)));
    assert.equal(overflow, false, `${name}: nothing overflows`);
    await page.screenshot({ path: `${evidence}/${name}-senders.png` });

    await section.getByRole("button", { name: "Remove Telegram sender 6660002" }).click();
    await row("Telegram sender 6660002").waitFor({ state: "detached" });
    assert.deepEqual(removed, [{ channel: "telegram", sender: "6660002" }], "Remove posts the channel and sender");
    await section.getByRole("button", { name: "Remove Discord sender 400000000000000001" }).click();
    await row("Discord sender 400000000000000001").getByText(/^Set on the host \(MARS_DISCORD_OWNER\)/).waitFor();
    assert.equal(await row("Discord sender 400000000000000001").getByRole("button").count(), 0, "a configured owner stays listed, without Remove, after its stored copy is removed");
    await page.screenshot({ path: `${evidence}/${name}-after-remove.png` });
    await page.close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS gateway senders UI: approved senders listed with Remove that posts { channel, sender } and drops the row; configured owners say where to remove them and have no Remove; the HTTP API owner is hidden; no overflow at 390px");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
