import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

// Against the running preview and its fixture host: side chats nested under their parent in
// Recents, a new side chat opened from the workbench lands nested, and file downloads.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/side-chats-download";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];

async function open(viewport, theme = "dark") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", acceptDownloads: true });
  await context.addInitScript(() => {
    if (window !== window.top || sessionStorage.getItem("check-cleared")) return;
    sessionStorage.setItem("check-cleared", "1");
    localStorage.removeItem("mars-workbench-v1");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  return page;
}
const recents = (page) => page.locator(".live-sidebar-history");

try {
  const page = await open({ width: 1440, height: 900 });
  // The fixture side chat is nested under its parent, not a row of its own.
  const parentRow = recents(page).locator("> div").filter({ has: page.getByRole("button", { name: "Tidy the Pi host deploy script", exact: true }) });
  const nested = parentRow.getByRole("list", { name: "Side chats" }).getByRole("button", { name: /^Name the release/ });
  await nested.waitFor();
  assert.equal(await recents(page).locator(".live-conversation").filter({ hasText: "Name the release" }).count(), 0, "a side chat is not a top-level row");

  // Opening it keeps it nested and marks it current.
  await nested.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "8");
  await page.getByText("Second Desk", { exact: false }).waitFor();
  assert.equal(await nested.getAttribute("aria-current"), "page");
  // A side chat names its parent like a subthread does, but it must not also be listed as one.
  assert.equal(await recents(page).locator(".live-nav").filter({ hasText: "Name the release" }).count(), 1, "the open side chat is listed once");
  await page.screenshot({ path: `${evidence}/desktop-dark-side-chat-open.png` });

  // A side chat started from the workbench is created under the chat in the main view.
  await page.getByRole("button", { name: "Tidy the Pi host deploy script", exact: true }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "1");
  await page.getByRole("button", { name: "Open workbench" }).click();
  const pane = page.getByRole("region", { name: "Workbench" });
  await pane.getByRole("button", { name: /^Side chat/ }).click();
  const created = page.waitForResponse((response) => response.url().endsWith("/api/conversations") && response.request().method() === "POST");
  await pane.getByRole("button", { name: "New side conversation" }).click();
  const request = (await created).request().postDataJSON();
  assert.equal(request.parentId, "1", "the new side chat names the main chat as its parent");
  await parentRow.getByRole("list", { name: "Side chats" }).getByRole("button", { name: "Side chat", exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await recents(page).locator(".live-conversation").filter({ hasText: /^Side chat$/ }).count(), 0, "and it never appears as its own row");
  await page.screenshot({ path: `${evidence}/desktop-dark-side-chat-created.png` });

  // Downloads: the header button for a text file, the labelled button for a binary file.
  await pane.getByRole("button", { name: "New workbench tab" }).click();
  await pane.getByRole("button", { name: /^Files/ }).click();
  await pane.getByRole("treeitem", { name: "notes" }).click();
  await pane.getByRole("treeitem", { name: "ideas.txt" }).click();
  const [textDownload] = await Promise.all([page.waitForEvent("download"), pane.getByRole("link", { name: "Download ideas.txt" }).click()]);
  assert.equal(textDownload.suggestedFilename(), "ideas.txt");
  assert.equal(await readFile(await textDownload.path(), "utf8"), "Fixture idea list\n- tree keyboard\n- quick open\n");

  await pane.getByRole("treeitem", { name: "assets" }).click();
  await pane.getByRole("treeitem", { name: "archive.zip" }).click();
  await pane.getByText("It cannot be previewed here.", { exact: false }).waitFor();
  const binaryButton = pane.getByRole("link", { name: /^Download 48/ });
  await binaryButton.waitFor();
  await page.screenshot({ path: `${evidence}/desktop-dark-binary-download.png` });
  const [zipDownload] = await Promise.all([page.waitForEvent("download"), binaryButton.click()]);
  assert.equal(zipDownload.suggestedFilename(), "archive.zip");
  assert.equal((await readFile(await zipDownload.path())).length, 48 * 1024, "binary bytes arrive intact");

  // Phone and light theme: nesting and the download button stay usable.
  for (const [viewport, theme, name] of [
    [{ width: 390, height: 844 }, "dark", "mobile-dark"],
    [{ width: 1440, height: 900 }, "light", "desktop-light"],
  ]) {
    const shot = await open(viewport, theme);
    if (viewport.width < 500) await shot.getByRole("button", { name: "Open navigation" }).click();
    await shot.getByRole("list", { name: "Side chats" }).first().waitFor();
    assert.equal(await shot.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
    await shot.screenshot({ path: `${evidence}/${name}-recents.png` });
    await shot.context().close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS side chats and downloads: fixture side chat nested under its parent and not a row, opening keeps it nested and current, workbench side chat posts parentId and lands nested, text and binary downloads with names and exact bytes, phone and light without overflow");
} finally {
  await browser.close();
}
