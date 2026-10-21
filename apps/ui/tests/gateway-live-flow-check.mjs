// Cross-client flow in the browser, against a real Pi host (docs/GATEWAY.md "Acceptance" 1):
// a message from a fake Telegram appears in Recents with the Telegram mark; the owner
// continues it in the web UI composer; the answer reaches Telegram; Telegram continues it
// and the web transcript shows it. Needs a host started for checks (staging, echo model,
// fake Telegram) and a dev UI pointed at it:
//   MARS_UI_BASE_URL (the dev UI), MARS_GATEWAY_FAKE_TELEGRAM (fake Telegram base URL),
//   MARS_GATEWAY_FAKE_TOKEN, MARS_GATEWAY_OWNER.
// packages/pi-host/scripts/gateway-live-preview.mjs starts all three.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const fake = process.env.MARS_GATEWAY_FAKE_TELEGRAM;
const token = process.env.MARS_GATEWAY_FAKE_TOKEN;
const owner = process.env.MARS_GATEWAY_OWNER;
if (!fake || !token || !owner) throw Error("Start packages/pi-host/scripts/gateway-live-preview.mjs and pass its MARS_GATEWAY_* values");
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/gateway-live";
await mkdir(evidence, { recursive: true });
const control = async (path, body) => (await fetch(`${fake}/__control/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) })).json();
const sent = async () => (await control("sent")).filter((m) => String(m.chat.id) === owner).map((m) => m.text);
const until = async (predicate, what, ms = 15000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const title = `Trip plan ${Date.now() % 100000}`;
  await control("message", { from: owner, text: title });
  await until(async () => (await sent()).includes("echo: " + title), "Telegram answer");

  await page.goto(uiBaseURL());
  await waitForHydration(page);
  const row = page.locator(".live-conversation", { hasText: title });
  await row.waitFor({ timeout: 15000 });
  assert.equal(await row.locator('.live-channel-mark[data-channel="telegram"]').count(), 1, "Recents shows the Telegram mark");
  await row.click();
  await page.getByText("echo: " + title).waitFor();
  await page.screenshot({ path: `${evidence}/1-telegram-conversation-in-web.png` });

  await page.getByRole("textbox", { name: "Message Mars" }).fill("Add a rain jacket");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("echo: Add a rain jacket").waitFor({ timeout: 15000 });
  await until(async () => (await sent()).includes("echo: Add a rain jacket"), "web reply mirrored to Telegram");

  await control("message", { from: owner, text: "And a map" });
  await page.getByText("echo: And a map").waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${evidence}/2-continued-from-telegram.png` });
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS gateway live flow in the browser: Telegram conversation in Recents with its mark, continued in the web composer with the answer sent to Telegram, continued from Telegram and shown on the web");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
