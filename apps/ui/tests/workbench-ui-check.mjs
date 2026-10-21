import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

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
  // An installed extension UI, mounted by the same module loader the Extensions page uses.
  await tab.route(`**/extensions/${"c".repeat(64)}/client.js`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export function mount(root){const p=document.createElement('p');p.textContent='Canvas notes mounted (fixture)';root.append(p);return()=>p.remove();}",
    }),
  );
  await tab.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: routes[path] ?? { accepted: true } });
  });
  await tab.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(tab);
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
  await desktop.getByRole("button", { name: /^Canvas notes/ }).click();
  await desktop.getByText("Canvas notes mounted (fixture)").waitFor();
  assert.equal(await desktop.getByRole("tab", { name: "Canvas notes" }).getAttribute("aria-selected"), "true", "the extension opens in its own tab");
  await desktop.screenshot({ path: evidence + "/desktop-extension.png" });
  await desktop.getByRole("button", { name: "Close Canvas notes tab" }).click();
  // It was the only tab, so closing it closes the workbench; the + reopens a New tab.
  assert.equal(await desktop.getByRole("region", { name: "Workbench" }).count(), 0, "closing the last tab closes the workbench");
  await desktop.getByRole("button", { name: "Open workbench" }).click();
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
  await waitForHydration(desktop);
  await desktop.getByRole("region", { name: "Workbench" }).waitFor();
  await desktop.getByRole("button", { name: "Close workbench" }).click();
  assert.equal(await desktop.getByRole("region", { name: "Workbench" }).count(), 0);

  // Keyboard users keep their place: a tool opened from the launcher takes focus, and
  // with many tabs the selected one stays scrolled into view.
  await desktop.getByRole("button", { name: "Open workbench" }).click();
  const filesTile = desktop.getByRole("button", { name: /^Files/ });
  await desktop.waitForFunction(() => [...document.querySelectorAll(".wb-tool")].some((tile) => tile.textContent.startsWith("Files") && !tile.disabled));
  await filesTile.focus();
  await desktop.keyboard.press("Enter");
  await desktop.waitForFunction(() => document.querySelector(".wb-pane")?.contains(document.activeElement) && document.activeElement !== document.querySelector(".wb-pane"), null, { timeout: 3000 });
  // Enough tabs that even at their 72px minimum they overflow, then select the first.
  for (let n = 0; n < 12; n++) await desktop.getByRole("button", { name: "New workbench tab" }).click();
  // Select a tab at the far left by clicking it after scrolling it into reach, then add
  // one more: the strip must bring the new (far right) selected tab back into view.
  await desktop.getByRole("tablist", { name: "Workbench tabs" }).evaluate((strip) => (strip.scrollLeft = 0));
  await desktop.getByRole("tab").first().click();
  await desktop.getByRole("tablist", { name: "Workbench tabs" }).evaluate((strip) => (strip.scrollLeft = 0));
  await desktop.getByRole("button", { name: "New workbench tab" }).click();
  await desktop.waitForTimeout(200);
  const selected = await desktop.locator(".wb-tab[data-selected]").boundingBox();
  const strip = await desktop.getByRole("tablist", { name: "Workbench tabs" }).boundingBox();
  assert.ok(selected.x >= strip.x - 1 && selected.x + selected.width <= strip.x + strip.width + 1, "the selected tab is fully visible in an overflowing strip");
  assert.equal(await desktop.getByRole("tablist", { name: "Workbench tabs" }).getAttribute("data-overflow"), "", "overflow is marked for the edge fade");
  await desktop.getByRole("button", { name: "Close workbench" }).click();

  // Narrow desktop: the pane stays at its 360px minimum and the separator reports what is shown.
  const narrow = await page({ width: 1024, height: 768 });
  await narrow.getByRole("button", { name: "Open workbench" }).click();
  const narrowPane = narrow.getByRole("region", { name: "Workbench" });
  await narrowPane.waitFor();
  // aria-valuenow follows the rendered width through a ResizeObserver, a frame later.
  await narrow.waitForFunction(() => {
    const pane = document.querySelector(".wb-pane");
    const value = Number(document.querySelector('[aria-label="Resize workbench"]')?.getAttribute("aria-valuenow"));
    return pane && Math.abs(pane.getBoundingClientRect().width - value) < 2;
  }, null, { timeout: 3000 });
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
  console.log("PASS workbench shell: launcher tool takes focus, selected tab scrolled into view, toggle, draft kept, launcher capabilities and reasons, suggestions, keyboard resize, tabs, gated shortcuts, expand, conversation switch keeps tabs, persistence, 1024px minimum, mobile sheet focus, inert, Escape, no overflow");
} finally {
  await browser.close();
}
