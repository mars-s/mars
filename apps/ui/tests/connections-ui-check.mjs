import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";
import { mkdir } from "node:fs/promises";

// Browser-only fixtures exercise the real settings component without accessing
// an account. These strings are test data, never usable credentials.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/live-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  viewport: { width: 1512, height: 949 },
  reducedMotion: "reduce",
});
const status = {
  discord: { configured: false, connected: false, guildId: "111111111111111111" },
  opencode: { configured: false, enabled: false },
};
const mutations = [];
let rejectSave = true;
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  // Read-only host version polling (components/settings/host-version.tsx) is not a mutation.
  if (path === "/api/host/version") return route.fulfill({ status: 404, json: {} });
  if (path === "/api/state")
    return route.fulfill({
      json: {
        runtime: "Pi Durable 1.3.0",
        conversationId: 1,
        conversations: [{ id: 1, title: "Pi conversation 1" }],
        auth: { connected: true, state: "connected", events: [] },
        models: [{ id: "gpt-6-luna", name: "Luna" }],
        extensions: [],
        view: {
          entries: [],
          docs: { "pi.agent": { model: { modelId: "gpt-6-luna" } }, "pi.live": {} },
        },
      },
    });
  if (path === "/api/connections" && request.method() === "GET")
    return route.fulfill({ json: status });
  mutations.push({ path, body: request.postDataJSON() });
  if (path === "/api/connections") {
    if (rejectSave)
      return route.fulfill({ status: 500, json: { error: "fixture-private-key-do-not-display" } });
    status.discord.configured = true;
    status.opencode.configured = true;
  }
  if (path === "/api/connections/connect") status.discord.connected = true;
  if (path === "/api/connections/disconnect") status.discord.connected = false;
  return route.fulfill({ json: status });
});
try {
  await page.goto(uiBaseURL(), {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await page.locator('button[aria-label="Choose model"]:enabled').waitFor();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Apps", exact: true }).click();
  const token = page.getByLabel("Bot token", { exact: true });
  const key = page.getByLabel("API key", { exact: true });
  await token.waitFor();
  assert.equal(await token.getAttribute("type"), "password");
  assert.equal(await key.getAttribute("type"), "password");
  assert.equal(mutations.length, 0);
  await token.fill("fixture-discord-token");
  await key.fill("fixture-opencode-key");
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(await token.inputValue(), "fixture-discord-token");
  assert.equal(await key.inputValue(), "fixture-opencode-key");
  assert.ok(
    !(await page.locator("body").innerText()).includes("fixture-private-key-do-not-display"),
  );
  rejectSave = false;
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.getByText("Credentials saved on the Pi host.", { exact: false }).waitFor();
  assert.equal(await token.inputValue(), "");
  assert.equal(await key.inputValue(), "");
  assert.equal(mutations.filter((request) => request.path.endsWith("/connect")).length, 0);
  assert.equal(mutations[1].body.openCodeApiKey, "fixture-opencode-key");
  await page.getByRole("button", { name: "Connect Discord", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Discord", exact: true }).waitFor();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(
    !storage.includes("fixture-discord-token") && !storage.includes("fixture-opencode-key"),
  );
  await page.screenshot({ path: `${evidence}/connections-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await token.scrollIntoViewIfNeeded();
  assert.ok((await token.boundingBox()).height >= 44);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: `${evidence}/connections-mobile.png` });
  process.stdout.write(
    "Connections UI fixture passed: masked credentials, error retention, confirmed clearing, explicit connection, no secret storage, mobile layout.\n",
  );
} finally {
  await browser.close();
}
