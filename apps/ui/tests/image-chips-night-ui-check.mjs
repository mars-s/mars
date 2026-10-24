// Image chips, night fixes (docs/IMAGE-CHIPS.md), against routed fixtures and Chromium's fake
// microphone: dictation keeps a chip pasted while it records; the slash menu opens before a
// chip and keeps it; a queued message the host refuses comes back with its image; the same
// image placed twice shows twice with both labels.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { browserLaunchOptions, composerText, uiBaseURL, waitForComposer, waitForHydration } from "./browser-options.mjs";

const options = browserLaunchOptions();
const browser = await chromium.launch({ ...options, args: [...options.args, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.grantPermissions(["microphone"]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
const ID = "4".repeat(64);
const receipt = { id: ID, name: "red.png", mimeType: "image/webp", size: 10, width: 24, height: 24, url: "/api/attachments/" + ID };
let running = false, failChat = false, entries = [];
const chats = [];
const voice = { seq: 0, text: "", done: false };
const script = ["Hello", "Hello there", "Hello there Mars"];
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/attachments/" + ID) return route.fulfill({ contentType: "image/png", body: png });
  if (url.pathname === "/api/attachments") return route.fulfill({ json: { attachment: receipt } });
  if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [{ name: "grill-me", description: "Interview" }] } });
  if (url.pathname === "/api/chat") {
    chats.push(request.postDataJSON());
    if (failChat) { failChat = false; return route.fulfill({ status: 500, json: { error: "Not accepted" } }); }
    return route.fulfill({ status: 202, json: { submissionId: "s" + chats.length } });
  }
  if (url.pathname === "/api/voice" && request.method() === "POST") {
    Object.assign(voice, { seq: 0, text: "", done: false });
    return route.fulfill({ status: 201, json: { id: "11111111-2222-3333-4444-555555555555", seq: 0, text: "", done: false } });
  }
  if (url.pathname.endsWith("/audio")) {
    if (voice.seq < script.length && voice.advance) { voice.text = script[voice.seq]; voice.seq++; }
    return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: false } });
  }
  if (url.pathname.endsWith("/stop")) { voice.done = true; voice.text = "Hello there, Mars."; voice.seq++; return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: true } }); }
  if (url.pathname.endsWith("/cancel")) { voice.done = true; return route.fulfill({ json: { cancelled: true } }); }
  if (url.pathname.startsWith("/api/voice/")) {
    const since = Number(url.searchParams.get("since"));
    for (let i = 0; i < 20 && voice.seq <= since && !voice.done; i++) await new Promise((r) => setTimeout(r, 100));
    return route.fulfill({ json: { id: "x", seq: voice.seq, text: voice.text, done: voice.done } });
  }
  return route.fulfill({ json: {
    runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
    auth: { connected: true, state: "connected", events: [] }, anthropicAuth: { connected: true, state: "connected", events: [] },
    providerReady: true, models: [{ id: "gpt-6-luna", name: "Luna", input: ["text", "image"] }], extensions: [],
    conversations: [{ id: 1, title: "Main" }], rootId: 1,
    view: { entries, docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } }, "pi.live": running ? { run: { taskId: 3 } } : {}, "pi.inbox": { items: [] } } },
  } });
});
const input = page.getByRole("textbox", { name: "Message Mars" });
const chips = () => input.locator(".live-image-chip").count();
const tray = () => page.locator(".live-image-draft").count();
async function paste() {
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "red.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  await page.waitForFunction(() => [...document.querySelectorAll(".live-image-draft small")].some((s) => s.textContent === "Ready"));
}
async function clear() {
  await input.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !document.querySelector(".live-image-draft") && document.querySelector('[aria-label="Message Mars"]').textContent === "");
}
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await waitForComposer(page);

  // Dictation keeps a chip pasted while it records.
  await input.click();
  await page.keyboard.type("Look:");
  await page.getByRole("button", { name: "Dictate with your voice" }).click();
  await page.getByRole("button", { name: "Stop dictation" }).waitFor();
  voice.advance = true;
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent.includes("Hello"), null, { timeout: 15000 });
  voice.advance = false;
  await paste();
  assert.equal(await chips(), 1);
  voice.advance = true;
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent.includes("Hello there Mars"), null, { timeout: 15000 });
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await page.getByRole("button", { name: "Dictate with your voice" }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent.includes("Hello there, Mars."));
  assert.equal(await chips(), 1, "the chip pasted during dictation stays");
  assert.equal(await tray(), 1, "and so does its image");
  assert.match(await composerText(input), /^Look: Hello there, Mars\.\s*Image 1/);
  checks.push("dictation keeps a chip");

  // The slash menu opens before a chip, and choosing keeps the chip.
  await clear();
  await paste();
  await page.keyboard.press("Home");
  await page.keyboard.type("/gr");
  await page.getByRole("listbox", { name: "Skills" }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent.startsWith("/grill-me"));
  assert.equal(await chips(), 1, "the chip survives choosing a skill");
  assert.equal(await tray(), 1);
  checks.push("slash menu with a chip");

  // A queued message the host refuses comes back with its image.
  await clear();
  running = true;
  await page.waitForFunction(() => document.querySelector(".live-prompt-header")?.textContent.includes("working") || document.querySelector('[aria-label="Queue message"]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await input.click();
  await page.keyboard.type("Later: ");
  await paste();
  failChat = true;
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]').textContent.startsWith("Later:"), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll(".live-image-draft").length === 1, null, { timeout: 15000 });
  assert.equal(await chips(), 1, "its chip is back");
  assert.match(chats.at(-1).text, /^Later: :image\[Image 1\]\{name=4{64}\}/);
  checks.push("refused queued message keeps its image");

  // The same image placed twice shows twice, each with its label.
  running = false;
  await clear();
  entries = [{ id: 40, data: { attachments: [receipt] }, model: [{ role: "user", content: [
    { type: "text", text: "Compare" }, { type: "text", text: `Attachment ${ID}: red.png [Image 1]` }, { type: "image" },
    { type: "text", text: "with" }, { type: "text", text: `Attachment ${ID}: red.png [Image 2]` }, { type: "image" },
  ] }] }];
  const bubble = page.locator(".live-user-bubble").last();
  await bubble.locator(".live-inline-image").nth(1).waitFor({ timeout: 15000 });
  assert.deepEqual(await bubble.locator(".live-inline-image figcaption").allInnerTexts(), ["Image 1", "Image 2"]);
  checks.push("one image placed twice keeps both labels");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await page.screenshot({ path: "/tmp/image-chips-night-failure.png" }).catch(() => {});
  console.log(JSON.stringify({ passed: false, checks, chats: chats.map((c) => c.text), error: String(error?.message || error).slice(0, 700) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
