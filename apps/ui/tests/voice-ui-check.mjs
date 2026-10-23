// Voice input in the browser, against routed fixtures and Chromium's fake microphone: the button
// is off without Claude, dictation sends 16-bit PCM chunks, words appear in the message box as the
// host returns them, stop keeps the final words after what was typed, and Escape cancels.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const options = browserLaunchOptions();
const browser = await chromium.launch({ ...options, args: [...options.args, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.grantPermissions(["microphone"]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let claude = false;
const voice = { audioBytes: 0, chunks: 0, odd: 0, seq: 0, text: "", done: false, cancelled: false, stopped: false };
const script = ["Hello", "Hello there", "Hello there Mars"];
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/state")
    return route.fulfill({ json: { runtime: "Pi Durable 1.3.0", conversationId: 1, auth: { connected: true, state: "connected", events: [] }, anthropicAuth: { connected: claude, state: claude ? "connected" : "idle", events: [] }, providerReady: true, models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }], view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } } } });
  if (url.pathname === "/api/voice" && request.method() === "POST") {
    Object.assign(voice, { seq: 0, text: "", done: false, cancelled: false, stopped: false });
    return route.fulfill({ status: 201, json: { id: "11111111-2222-3333-4444-555555555555", seq: 0, text: "", done: false } });
  }
  if (url.pathname.endsWith("/audio")) {
    const bytes = Buffer.from(request.postDataJSON().audio, "base64").length;
    voice.audioBytes += bytes;
    voice.chunks++;
    if (bytes % 2) voice.odd++;
    // Each chunk moves the fake transcript on.
    if (voice.seq < script.length) { voice.text = script[voice.seq]; voice.seq++; }
    return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: false } });
  }
  if (url.pathname.endsWith("/stop")) { voice.stopped = true; voice.done = true; voice.text = "Hello there, Mars."; voice.seq++; return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: true } }); }
  if (url.pathname.endsWith("/cancel")) { voice.cancelled = true; voice.done = true; return route.fulfill({ json: { cancelled: true } }); }
  if (url.pathname.startsWith("/api/voice/")) {
    const since = Number(url.searchParams.get("since"));
    for (let i = 0; i < 20 && voice.seq <= since && !voice.done; i++) await new Promise((r) => setTimeout(r, 100));
    return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: voice.done, ...(voice.cancelled ? { error: "Cancelled." } : {}) } });
  }
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const mic = page.getByRole("button", { name: "Dictate with your voice" });
  assert.equal(await mic.isDisabled(), true, "off until Claude is connected");
  assert.match(await mic.getAttribute("title"), /Connect Claude/);
  claude = true;
  await page.waitForFunction(() => !document.querySelector('[aria-label="Dictate with your voice"]').disabled, null, { timeout: 10000 });

  const input = page.getByRole("textbox", { name: "Message Mars" });
  await input.fill("Note:");
  await mic.click();
  const stop = page.getByRole("button", { name: "Stop dictation" });
  await stop.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').value === "Note: Hello there Mars", null, { timeout: 15000 });
  assert.ok(voice.chunks >= 3 && voice.audioBytes > 3000, `audio was sent (${voice.chunks} chunks, ${voice.audioBytes} bytes)`);
  assert.equal(voice.odd, 0, "whole 16-bit samples only");
  await stop.click();
  await mic.waitFor();
  assert.equal(await input.inputValue(), "Note: Hello there, Mars.", "the final words follow what was typed");
  assert.equal(voice.stopped, true);

  // Escape cancels and restores the text from before.
  await input.fill("Draft");
  await mic.click();
  await stop.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').value.startsWith("Draft Hello"), null, { timeout: 15000 });
  await page.keyboard.press("Escape");
  await mic.waitFor();
  assert.equal(await input.inputValue(), "Draft");
  assert.equal(voice.cancelled, true);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["off without Claude", "PCM chunks sent", "live words in the box", "stop keeps final words after typed text", "Escape cancels and restores"] }));
} finally {
  await browser.close();
}
