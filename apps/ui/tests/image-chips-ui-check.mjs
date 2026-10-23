// Images placed in the message text (docs/IMAGE-CHIPS.md), against routed fixtures: a pasted
// image becomes a chip where the cursor is; deleting the chip or the tray image removes both;
// the message is sent with each chip naming its host image; the sent message shows each image
// where it was placed.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { browserLaunchOptions, composerText, uiBaseURL, waitForComposer, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const colours = { red: { r: 220, g: 30, b: 30 }, blue: { r: 30, g: 60, b: 220 }, green: { r: 30, g: 180, b: 60 } };
const pngs = Object.fromEntries(await Promise.all(Object.entries(colours).map(async ([name, background]) =>
  [name, await sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer()])));
const idOf = { red: "1".repeat(64), blue: "2".repeat(64), green: "3".repeat(64) };
const receipt = (name) => ({ id: idOf[name], name: name + ".png", mimeType: "image/webp", size: 10, width: 32, height: 32, url: "/api/attachments/" + idOf[name] });
const sends = [];
let entries = [];
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const colour = Object.keys(idOf).find((name) => url.pathname === "/api/attachments/" + idOf[name]);
  if (colour) return route.fulfill({ contentType: "image/png", body: pngs[colour] });
  if (url.pathname === "/api/attachments") {
    const name = decodeURIComponent(request.headers()["x-file-name"]).replace(".png", "");
    return route.fulfill({ json: { attachment: receipt(name) } });
  }
  if (url.pathname === "/api/chat") {
    const body = request.postDataJSON();
    sends.push(body);
    // What the host stores (packages/pi-host/image-store.mjs): text, then each image's line where its chip was.
    entries = [{ id: 30, data: { attachments: body.attachmentIds.map((id) => receipt(Object.keys(idOf).find((n) => idOf[n] === id))) }, model: [{ role: "user", content: [
      { type: "text", text: "Make this" },
      { type: "text", text: `Attachment ${idOf.red}: red.png [Image 1]` }, { type: "image", mimeType: "image/webp" },
      { type: "text", text: "look like" },
      { type: "text", text: `Attachment ${idOf.blue}: blue.png [Image 2]` }, { type: "image", mimeType: "image/webp" },
    ] }] }];
    return route.fulfill({ json: { submissionId: "s1" } });
  }
  return route.fulfill({ json: {
    runtime: "Pi Durable", conversationId: 1, selectedConversationId: 1,
    auth: { connected: true, state: "connected", events: [] }, providerReady: true,
    models: [{ id: "gpt-6-luna", name: "Luna", input: ["text", "image"] }], extensions: [],
    conversations: [{ id: 1, title: "Images" }], rootId: 1,
    view: { entries, docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
  } });
});
const input = page.getByRole("textbox", { name: "Message Mars" });
async function paste(name) {
  await input.evaluate((element, [file, base64]) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], file, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, [name + ".png", pngs[name].toString("base64")]);
  await page.getByRole("button", { name: `Remove ${name}.png` }).waitFor();
}
const chips = () => input.locator(".live-image-chip").allInnerTexts();
const checks = [];
try {
  await page.goto(uiBaseURL() + "?conversation=1", { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await waitForComposer(page);
  await input.click();
  await page.keyboard.type("Make this ");
  await paste("red");
  await page.keyboard.type("look like ");
  await paste("blue");
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Message Mars"] .live-image-chip img').length === 2);
  assert.deepEqual(await chips(), ["Image 1", "Image 2"]);
  assert.match(await composerText(input), /^Make this Image 1 look like Image 2 $/);
  await page.locator(".live-prompt-shell").screenshot({ path: "/tmp/image-chips-composer.png" });
  checks.push("pasted images become chips where the cursor is");

  // A third image, then Backspace deletes its chip, and the image goes too.
  await paste("green");
  assert.deepEqual(await chips(), ["Image 1", "Image 2", "Image 3"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.getByRole("button", { name: "Remove green.png" }).waitFor({ state: "detached" });
  assert.deepEqual(await chips(), ["Image 1", "Image 2"]);
  checks.push("deleting a chip removes its image");

  // Removing an image from the tray removes its chip.
  await paste("green");
  assert.equal((await chips()).length, 3);
  await page.getByRole("button", { name: "Remove green.png" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Message Mars"] .live-image-chip').length === 2);
  checks.push("removing an image removes its chip");

  await page.getByText("Ready", { exact: true }).first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".live-image-draft small")].every((s) => s.textContent === "Ready"));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="Message Mars"]')?.textContent === "");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text.trim(), `Make this :image[Image 1]{name=${idOf.red}} look like :image[Image 2]{name=${idOf.blue}}`);
  assert.deepEqual(sends[0].attachmentIds, [idOf.red, idOf.blue]);
  checks.push("sent with each chip naming its host image");

  const bubble = page.locator(".live-user-bubble").last();
  await bubble.locator(".live-inline-image img").nth(1).waitFor();
  const order = await bubble.evaluate((element) =>
    [...element.querySelectorAll("p, .live-inline-image figcaption, span")]
      .map((node) => node.textContent.trim()).filter(Boolean)
      .filter((text, index, all) => text !== all[index - 1]));
  assert.deepEqual(order.filter((text) => ["Make this", "Image 1", "look like", "Image 2"].includes(text)), ["Make this", "Image 1", "look like", "Image 2"]);
  assert.equal(await bubble.getByText(/^Attachment /).count(), 0, "no attachment lines in the message");
  checks.push("the sent message shows each image where it was placed");

  await page.screenshot({ path: "/tmp/image-chips-sent.png" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await page.screenshot({ path: "/tmp/image-chips-failure.png" }).catch(() => {});
  console.log(JSON.stringify({ passed: false, checks, sends, error: String(error?.message || error).slice(0, 700) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
