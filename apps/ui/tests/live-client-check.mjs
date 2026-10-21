import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/live-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1512, height: 949 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const entries = [
  { id: 1, model: [{ role: "user", content: "Show me a simple table." }] },
  {
    id: 2,
    model: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '## A durable conversation\n\n| Feature | State |\n| --- | --- |\n| History | Saved |\n\n```ts\nconst status = "ready";\n```',
          },
          { type: "toolCall", id: "test-read", name: "read", arguments: { path: "notes.md" } },
        ],
      },
    ],
  },
  {
    id: 3,
    model: [
      {
        role: "toolResult",
        toolCallId: "test-read",
        content: [{ type: "text", text: "Fixture file content" }],
      },
    ],
  },
];
let running = false;
const requests = [];
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
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
          entries,
          docs: {
            "pi.agent": { model: { modelId: "gpt-6-luna" } },
            "pi.live": running ? { run: { taskId: 4 } } : {},
          },
        },
      },
    });
  requests.push({ path, body: request.postDataJSON() });
  if (path === "/api/chat") running = true;
  if (path === "/api/abort") running = false;
  return route.fulfill({ json: { accepted: true }, status: 202 });
});
try {
  await page.goto(uiBaseURL(), {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await page.getByRole("heading", { name: "A durable conversation" }).waitFor();
  assert.equal(await page.getByRole("table").count(), 1);
  await page.locator(".live-activity > summary").click();
  await page.getByText("Read file", { exact: true }).click();
  await page.getByText("Fixture file content").waitFor({ state: "visible" });
  await page.waitForTimeout(1400);
  assert.equal(await page.locator(".live-activity").getAttribute("open"), "");
  const input = page.getByRole("textbox", { name: "Message Mars" });
  await input.fill("Hello live Pi");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  assert.equal(requests.filter((request) => request.path === "/api/chat").length, 0);
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop response" }).waitFor();
  assert.equal(requests.filter((request) => request.path === "/api/chat").length, 1);
  assert.equal(requests[0].body.text, "Hello live Pi");
  assert.match(requests[0].body.requestId, /^[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "Stop response" }).click();
  assert.equal(requests.filter((request) => request.path === "/api/abort").length, 1);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /^Light\b/ }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: /^Dark\b/ }).click();
  await page.getByRole("button", { name: /^OLED\b/ }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "oled");
  assert.equal(await page.evaluate(() => localStorage.getItem("mars-live-theme")), "oled");
  await page.getByRole("button", { name: /^Dark\b/ }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.screenshot({ path: `${evidence}/fixture-desktop.png` });
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  assert.equal(await page.locator(".live-sidebar .live-nav-selected").count(), 1);
  assert.equal(await page.locator(".live-sidebar .live-nav-selected").innerText(), "Extensions");
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".live-send")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    "0s",
  );
  await page.screenshot({ path: `${evidence}/fixture-mobile.png` });
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "A durable conversation" }).waitFor();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /^Light\b/ }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.deepEqual(errors, []);
  const result = {
    mode: "browser fixture, no provider or real host mutation",
    checks: [
      "native Markdown table/code",
      "tool disclosure preserved across polling",
      "IME Enter prevented",
      "ordinary Enter one unique operation",
      "explicit stop host request",
      "settings appearance",
      "mobile drawer Escape",
      "mobile overflow",
      "one selected desktop navigation destination",
      "reduced motion",
      "no browser exceptions",
      "blocked browser storage does not prevent chat or theme changes",
    ],
    passed: true,
  };
  await writeFile(`${evidence}/fixture-browser-check.json`, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
