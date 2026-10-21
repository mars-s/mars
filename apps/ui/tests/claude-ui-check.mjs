import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/live-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});
let pending = false,
  connected = false;
const calls = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  // Read-only host version polling (components/settings/host-version.tsx) is not a mutation.
  if (path === "/api/host/version") return route.fulfill({ status: 404, json: {} });
  if (path === "/api/state")
    return route.fulfill({
      json: {
        runtime: "Pi Durable 1.3.0",
        providerReady: connected,
        conversationId: 1,
        conversations: [{ id: 1, title: "Pi conversation 1" }],
        auth: { connected: false },
        anthropicAuth: {
          connected,
          state: connected ? "connected" : pending ? "pending" : "idle",
          events: pending
            ? [{ type: "auth_url", url: "https://claude.ai/oauth/authorize?fixture=1" }]
            : [],
          prompt: pending ? { type: "manual_code", placeholder: "code#state" } : null,
        },
        models: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }],
        extensions: [],
        view: {
          entries: [],
          docs: { "pi.agent": { model: { provider: "anthropic", modelId: "claude-opus-5-5" } } },
        },
      },
    });
  calls.push({ path, body: route.request().postDataJSON() });
  if (path === "/api/login") pending = true;
  if (path === "/api/login-answer") {
    pending = false;
    connected = true;
  }
  return route.fulfill({ json: { accepted: true } });
});
try {
  await page.goto(uiBaseURL(), {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await page.locator('button[aria-label="Choose model"]:enabled').waitFor();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with Claude", exact: true }).click();
  await page.getByRole("link", { name: "Continue to Claude sign-in" }).waitFor();
  const code = page.getByLabel("Claude authorisation code");
  assert.equal(await code.getAttribute("type"), "password");
  await code.fill("fixture-code#state");
  await page.screenshot({ path: evidence + "/claude-signin-mobile.png" });
  await page.getByRole("button", { name: "Complete Claude sign-in", exact: true }).click();
  await page
    .getByText("Choose Claude Opus 5.5 from the conversation model menu to work on the UI.")
    .waitFor();
  assert.deepEqual(calls, [
    { path: "/api/login", body: { provider: "anthropic" } },
    { path: "/api/login-answer", body: { provider: "anthropic", answer: "fixture-code#state" } },
  ]);
  assert.equal(
    await page.evaluate(() => Object.values(localStorage).some((v) => v.includes("fixture-code"))),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS fixture-only Claude OAuth controls, provider isolation, masked code, mobile layout, no code persistence or browser exceptions.",
  );
} finally {
  await browser.close();
}
