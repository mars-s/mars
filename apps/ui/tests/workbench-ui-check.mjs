import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";

// Fixture-only: every workbench route is answered here so the check is independent of a host.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/workbench-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const state = {
  runtime: "Pi Durable 1.3.0",
  providerReady: true,
  conversationId: "1",
  selectedConversationId: "1",
  conversationTitle: "Workbench fixture",
  conversations: [{ id: "1", title: "Workbench fixture" }],
  auth: { connected: true, state: "connected", events: [] },
  models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["low", "medium"] }],
  thinkingLevel: "medium",
  extensions: [{ name: "canvas", title: "Canvas notes", hash: "c".repeat(64), enabled: true, uiEnabled: true }],
  view: {
    entries: [{ id: 1, model: [{ role: "user", content: [{ type: "text", text: "Hello workbench" }] }] }],
    docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } } },
  },
};
const routes = {
  "/api/state": state,
  "/api/workbench/capabilities": {
    tools: {
      changes: { available: false, reason: "Fixture: no git repository" },
      files: { available: true },
      terminal: { available: false, reason: "python3 with the pty module was not found on the host." },
      "side-chat": { available: true },
      page: { available: true },
      browser: { available: true },
    },
  },
  "/api/workbench/suggestions": { suggestions: [{ kind: "service", title: "Docs site", port: 3100 }, { kind: "page", title: "Release plan", name: "release-plan" }] },
};
async function page(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const tab = await context.newPage();
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: routes[path] ?? { accepted: true } });
  });
  await tab.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await tab.getByRole("textbox", { name: "Message Mars" }).waitFor();
  return tab;
}
try {
  const desktop = await page({ width: 1440, height: 900 });
  const input = desktop.getByRole("textbox", { name: "Message Mars" });
  await input.fill("Draft survives the split");
  const toggle = desktop.getByRole("button", { name: "Open workbench" });
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  const pane = desktop.getByRole("region", { name: "Workbench" });
  await pane.waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await input.inputValue(), "Draft survives the split", "opening keeps the draft");
  await desktop.getByRole("heading", { name: "Tools" }).waitFor();
  await desktop.getByRole("heading", { name: "Suggested" }).waitFor();
  assert.equal(await desktop.getByRole("button", { name: /^Terminal/ }).isDisabled(), true, "unavailable tool is disabled");
  await desktop.getByText("python3 with the pty module was not found on the host.").waitFor();
  assert.equal(await desktop.getByRole("button", { name: /^Files/ }).isDisabled(), false);
  await desktop.getByRole("button", { name: /^Docs site/ }).waitFor();
  await desktop.screenshot({ path: evidence + "/desktop-launcher.png" });

  // Resize by keyboard; width follows and is reported.
  const divider = desktop.getByRole("separator", { name: "Resize workbench" });
  const before = Number(await divider.getAttribute("aria-valuenow"));
  await divider.focus();
  await desktop.keyboard.press("Shift+ArrowLeft");
  await desktop.waitForFunction(
    (target) => Number(document.querySelector('[aria-label="Resize workbench"]')?.getAttribute("aria-valuenow")) === target,
    before + 64,
    { timeout: 3000 },
  );
  const after = Number(await divider.getAttribute("aria-valuenow"));
  const box = await pane.boundingBox();
  assert.ok(Math.abs(box.width - after) < 2, "pane width matches the separator value");

  // Tabs: More tools lists extensions; a new tab and close behave.
  await desktop.getByRole("button", { name: "More tools…" }).click();
  await desktop.getByRole("button", { name: /^Canvas notes/ }).waitFor();
  await desktop.getByRole("button", { name: "New workbench tab" }).click();
  assert.equal(await desktop.getByRole("tab").count(), 2);
  await desktop.getByRole("button", { name: "Close New tab tab" }).first().click();
  assert.equal(await desktop.getByRole("tab").count(), 1);

  // A shortcut for a tool the host cannot run opens the New tab, never a broken pane.
  await desktop.locator("body").click({ position: { x: 5, y: 450 } });
  await desktop.keyboard.press("Control+`");
  assert.equal(await desktop.getByRole("tab", { name: "Terminal" }).count(), 0, "disabled Terminal shortcut is gated");
  assert.equal(await desktop.getByRole("tab", { name: "New tab" }).count(), 2, "gated shortcut opened a New tab");
  await desktop.getByRole("button", { name: "Close New tab tab" }).first().click();

  // Expand hides the chat; restore brings it back with the draft.
  await desktop.getByRole("button", { name: "Expand workbench" }).click();
  assert.equal(await input.isVisible(), false);
  await desktop.getByRole("button", { name: "Restore workbench" }).click();
  assert.equal(await input.inputValue(), "Draft survives the split");

  // Switching conversations remounts only the main chat; the workbench keeps its tabs.
  await desktop.getByRole("button", { name: "New workbench tab" }).click();
  const tabsBefore = await desktop.getByRole("tab").count();
  state.conversations.push({ id: "2", title: "Second chat" });
  await desktop.reload();
  await desktop.getByRole("region", { name: "Workbench" }).waitFor();
  await desktop.getByRole("button", { name: /Second chat/ }).first().click();
  await desktop.getByRole("region", { name: "Workbench" }).waitFor();
  assert.equal(await desktop.getByRole("tab").count(), tabsBefore, "conversation switch keeps workbench tabs");
  await desktop.getByRole("button", { name: "Close New tab tab" }).first().click();

  // Persistence across reload.
  await desktop.reload();
  await desktop.getByRole("region", { name: "Workbench" }).waitFor();
  await desktop.getByRole("button", { name: "Close workbench" }).click();
  assert.equal(await desktop.getByRole("region", { name: "Workbench" }).count(), 0);

  // Narrow desktop: the pane stays at its 360px minimum and the separator reports what is shown.
  const narrow = await page({ width: 1024, height: 768 });
  await narrow.getByRole("button", { name: "Open workbench" }).click();
  const narrowPane = narrow.getByRole("region", { name: "Workbench" });
  await narrowPane.waitFor();
  const narrowBox = await narrowPane.boundingBox();
  const narrowValue = Number(await narrow.getByRole("separator", { name: "Resize workbench" }).getAttribute("aria-valuenow"));
  assert.ok(narrowBox.width >= 359, `pane keeps its minimum at 1024px (got ${narrowBox.width})`);
  assert.ok(Math.abs(narrowBox.width - narrowValue) < 2, "separator value matches the rendered width");
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no overflow at 1024px");

  const mobile = await page({ width: 390, height: 844 });
  const mobileToggle = mobile.getByRole("button", { name: "Open workbench" });
  await mobileToggle.click();
  const sheet = mobile.getByRole("region", { name: "Workbench" });
  await sheet.waitFor();
  assert.equal(await sheet.evaluate((element) => element.contains(document.activeElement)), true, "focus moves into the sheet");
  assert.equal(await mobile.locator(".live-main").evaluate((element) => element.inert), true, "chat behind the sheet is inert");
  const sheetBox = await sheet.boundingBox();
  assert.ok(sheetBox.width >= 389 && sheetBox.x <= 1, "full-screen sheet on phones");
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow");
  await mobile.screenshot({ path: evidence + "/mobile-launcher.png" });
  await mobile.keyboard.press("Escape");
  assert.equal(await sheet.count(), 0, "Escape closes the sheet");
  await mobile.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open workbench", null, { timeout: 3000 });
  assert.equal(await mobile.locator(".live-main").evaluate((element) => element.inert), false);
  await mobileToggle.click();
  await sheet.waitFor();
  await mobile.getByRole("button", { name: "Back to chat" }).click();
  assert.equal(await sheet.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS workbench shell: toggle, draft kept, launcher capabilities and reasons, suggestions, keyboard resize, tabs, gated shortcuts, expand, conversation switch keeps tabs, persistence, 1024px minimum, mobile sheet focus, inert, Escape, no overflow");
} finally {
  await browser.close();
}
