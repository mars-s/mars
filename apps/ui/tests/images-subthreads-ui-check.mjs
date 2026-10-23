import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, composerText, composerEditable } from "./browser-options.mjs";
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/images-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const id = "a".repeat(64);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const receipt = {
  id,
  name: "pasted.png",
  mimeType: "image/webp",
  size: png.length,
  width: 1,
  height: 1,
  url: `/api/attachments/${id}`,
};
const messages = new Map();
const sends = [];
let failUpload = false;
let failChat = false;
let uploads = 0;
let workflowStatus = "running";
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === `/api/attachments/${id}`)
    return route.fulfill({ contentType: "image/png", body: png });
  if (url.pathname === "/api/attachments") {
    uploads++;
    return route.fulfill({
      status: failUpload ? 400 : 200,
      json: failUpload ? { error: "Image upload rejected" } : { attachment: receipt },
    });
  }
  if (url.pathname === "/api/chat") {
    const body = request.postDataJSON();
    sends.push(body);
    if (failChat) {
      failChat = false;
      return route.fulfill({ status: 500, json: { error: "Retry this message" } });
    }
    messages.set(String(body.conversationId), [
      {
        id: 20,
        data: { attachments: body.attachmentIds?.length ? [receipt] : [] },
        model: [{ role: "user", content: body.text }],
      },
    ]);
    return route.fulfill({ json: { ok: true } });
  }
  if (url.pathname === "/api/workflows/stop") {
    workflowStatus = "aborted";
    return route.fulfill({ json: { ok: true } });
  }
  const selected = url.searchParams.get("conversationId") || "1";
  return route.fulfill({
    json: {
      runtime: "Pi Durable",
      selectedConversationId: selected,
      conversationId: selected,
      parentConversationId: selected === "2" ? "1" : undefined,
      conversationTitle: selected === "2" ? "Inspect image" : "Image task",
      auth: { connected: true },
      providerReady: true,
      conversations: [{ id: "1", title: "Image task" }],
      subthreads: [
        {
          id: "2",
          conversationId: "1",
          title: "Inspect image",
          status: "running",
        },
      ],
      workers: [
        {
          id: "2",
          conversationId: "1",
          title: "Inspect image",
          status: "running",
        },
      ],
      workflows: [
        {
          id: "flow-1",
          conversationId: "1",
          title: "Map, pick, explain",
          status: workflowStatus,
          steps: [
            {
              index: 0,
              title: "Map",
              status: "complete",
              conversationId: "2",
              modelId: "Luna",
              durationMs: 1000,
              usage: { models: { "openai/Luna": { input: 12 } } },
            },
            { index: 1, title: "Pick", status: workflowStatus },
            { index: 2, title: "Explain", status: "pending" },
          ],
        },
      ],
      view: {
        entries: messages.get(selected) || [],
        docs: { "pi.agent": { model: { modelId: "Luna" } }, "pi.live": {} },
      },
    },
  });
});
async function paste() {
  await page.waitForFunction(() => {
    const input = document.querySelector('[contenteditable][aria-label="Message Mars"]');
    return (
      input instanceof HTMLElement &&
      input.isContentEditable &&
      new URL(location.href).searchParams.has("conversation")
    );
  });
  await page.getByRole("textbox", { name: "Message Mars" }).focus();
  await page.getByRole("textbox", { name: "Message Mars" }).evaluate((input, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png.toString("base64"));
}
try {
  await page.goto(
    uiBaseURL(),
  );
  await page.getByRole("textbox", { name: "Message Mars" }).waitFor();
  await paste();
  await page.getByRole("button", { name: "Remove pasted.png" }).waitFor();
  await page.locator(".live-image-draft img").waitFor();
  assert.equal(await page.locator(".live-image-draft img").count(), 1);
  await page.getByText("Ready", { exact: true }).waitFor();
  const uploadedBeforeSwitch = uploads;
  await page.locator(".live-sidebar .live-subthread").click();
  await page.getByRole("button", { name: "Back to parent" }).click();
  await page.getByRole("button", { name: "Remove pasted.png" }).waitFor();
  await page.getByText("Ready", { exact: true }).waitFor();
  assert.equal(uploads, uploadedBeforeSwitch);
  await page.getByRole("button", { name: "Remove pasted.png" }).click();
  await paste();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator(".live-inline-image img").waitFor();
  assert.deepEqual(sends[0].attachmentIds, [id]);
  // A pasted image is a chip in the text, sent with the host's attachment id (docs/IMAGE-CHIPS.md).
  assert.equal(sends[0].text, `:image[Image 1]{name=${id}}`);
  await page.reload();
  await page.locator(".live-inline-image img").waitFor();
  await paste();
  await paste();
  // Type after the two chips; replacing the text would delete them, and with them the images.
  await page.getByRole("textbox", { name: "Message Mars" }).press("End");
  await page.keyboard.type("Retry caption");
  failChat = true;
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Retry this message", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Message Mars"]')?.textContent?.endsWith("Retry caption"),
  );
  assert.match(
    await composerText(page.getByRole("textbox", { name: "Message Mars" })),
    /Image 1.*Image 2.*Retry caption$/,
  );
  await page.getByRole("button", { name: "Remove pasted.png" }).first().waitFor();
  const failedSend = sends.at(-1);
  assert.deepEqual(failedSend.attachmentIds, [id]);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  // The fixture gives both pastes one host id, so the second chip reads as its label.
  await page.locator(".live-user-bubble").getByText(/Retry caption$/).waitFor();
  assert.equal(sends.at(-1).requestId, failedSend.requestId);
  assert.deepEqual(sends.at(-1).attachmentIds, [id]);

  await page.locator(".live-sidebar .live-subthread").click();
  await page.getByRole("button", { name: "Back to parent" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("conversation"), "2");
  await page.getByRole("textbox", { name: "Message Mars" }).fill("Follow up");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Follow up", { exact: true }).waitFor();
  assert.equal(String(sends.at(-1).conversationId), "2");
  await page.getByRole("button", { name: "Back to parent" }).click();
  await page.locator(".live-workers > summary").click();
  await page.locator(".live-workflow > summary").click();
  await page.getByRole("button", { name: "Stop workflow", exact: true }).click();
  await page.locator(".live-workflow > summary").getByText("aborted", { exact: true }).waitFor();
  failUpload = true;
  await paste();
  await page.getByText("Image upload rejected", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Remove pasted.png" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(".live-mobile-nav .live-subthread").click();
  await page.getByRole("button", { name: "Back to parent" }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${evidence}/images-fixture-pass.png`, fullPage: true });
  console.log(
    "PASS image paste, preview, remove, image-only send, refresh, child followup, workflow stop and mobile navigation",
  );
} catch (error) {
  await page.screenshot({
    path: `${evidence}/images-fixture-failure.png`,
    fullPage: true,
  });
  console.error(
    JSON.stringify({
      uploads,
      sends,
      errors,
      url: page.url(),
      inputDisabled: await composerEditable(page.getByRole("textbox", { name: "Message Mars" })).then((editable) => !editable, () => "no composer"),
      body: (await page.locator("body").innerText()).slice(-5000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
