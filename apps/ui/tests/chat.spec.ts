import { expect, test, type Page } from "@playwright/test";

const STORAGE = "mars-workspace-v1";
const browserErrors = new WeakMap<Page, string[]>();

async function savedWorkspace(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || "{}").state, STORAGE);
}

async function newConversation(page: Page) {
  await page.getByRole("button", { name: /^New session/ }).first().click();
  await expect(page.getByRole("textbox", { name: "Message Mars", exact: true })).toBeVisible();
  await expect(page.locator(".mars-welcome-suggestions")).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Mars", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
}

async function waitForReply(page: Page) {
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".mars-assistant-message").last().getByRole("button", { name: "Retry response" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator('.mars-chat[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Mars", exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "The chat should not report browser runtime or hydration errors").toEqual([]);
});

test("streams markdown, copies, retries, and edits a user turn", async ({ page, context }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await newConversation(page);
  await send(page, "What is the first milestone for Mars?");
  await waitForReply(page);
  await expect(page.locator(".mars-assistant-message strong").first()).toContainText("one conversation");
  await expect(page.locator(".mars-assistant-message ol li")).toHaveCount(4);
  await page.locator(".mars-assistant-message").getByRole("button", { name: "Copy message" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("one conversation");
  const before = await savedWorkspace(page);
  const firstId = before.sessions.find((session: { id: string }) => session.id === before.activeSessionId).messages.at(-1).id;

  await page.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
  await waitForReply(page);
  await expect(page.locator(".mars-message")).toHaveCount(2);
  const retried = await savedWorkspace(page);
  expect(retried.sessions.find((session: { id: string }) => session.id === retried.activeSessionId).messages.at(-1).id).not.toBe(firstId);

  await page.locator(".mars-user-message").hover();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit your message" }).fill("What should Mars remember?");
  await page.getByRole("button", { name: "Save & send" }).click();
  await waitForReply(page);
  await expect(page.locator(".mars-user-bubble")).toHaveText("What should Mars remember?");
  await expect(page.locator(".mars-assistant-message")).toContainText("three kinds of context");
  await expect(page.locator(".mars-message")).toHaveCount(2);
});

test("Stop ends a local stream and no later chunks change the message", async ({ page }) => {
  await newConversation(page);
  await send(page, "Help me plan the Mars milestone.");
  await expect(page.locator(".mars-markdown")).toContainText("first milestone");
  await page.getByRole("button", { name: "Stop response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toHaveCount(0);
  await expect(page.locator(".mars-message-status")).toHaveText("Response stopped");
  const before = await savedWorkspace(page);
  const message = before.sessions.find((session: { id: string }) => session.id === before.activeSessionId).messages.at(-1);
  expect(message.status).toBe("cancelled");
  await page.waitForTimeout(350);
  const after = await savedWorkspace(page);
  expect(after.sessions.find((session: { id: string }) => session.id === after.activeSessionId).messages.at(-1).content).toBe(message.content);
});

test("switching sessions cancels only the local stream that was left", async ({ page }) => {
  await newConversation(page);
  await send(page, "Plan a durable milestone for Mars");
  await expect(page.locator(".mars-markdown")).toContainText("first milestone");
  const active = (await savedWorkspace(page)).activeSessionId;
  await page.getByRole("button", { name: "Memory & continuity", exact: true }).click();
  await expect(page.locator(".mars-user-bubble")).toHaveText("What should Mars remember between conversations?");
  const switched = await savedWorkspace(page);
  const prior = switched.sessions.find((session: { id: string }) => session.id === active).messages.at(-1);
  expect(prior.status).toBe("cancelled");
  expect(switched.activeSessionId).toBe("mars-memory");
  await page.waitForTimeout(350);
  const later = await savedWorkspace(page);
  expect(later.sessions.find((session: { id: string }) => session.id === active).messages.at(-1).content).toBe(prior.content);
  await page.getByRole("button", { name: "Plan a durable milestone for Mars", exact: true }).click();
  await expect(page.locator(".mars-message-status")).toHaveText("Response stopped");
});

test("slash commands work from the keyboard and model preferences survive reload", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Mars", exact: true });
  await composer.fill("/");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await composer.press("ArrowDown");
  await expect(page.getByRole("option", { name: /\/tasks/ })).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(page.getByRole("complementary", { name: "Background tasks panel" })).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(page.locator(".mars-message")).toHaveCount(4);

  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitemradio", { name: "Local model", exact: true }).click();
  await page.getByRole("button", { name: /^Permission mode:/ }).click();
  await page.getByRole("menuitemradio", { name: /Plan mode/ }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Model: Local model", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Permission mode: Plan mode", exact: true })).toBeVisible();
});

test("reload restores an interrupted local response as cancelled", async ({ page }) => {
  await newConversation(page);
  await send(page, "Help me plan a durable Mars runtime.");
  const active = (await savedWorkspace(page)).activeSessionId;
  await page.reload();
  await expect(page.locator(".mars-message-status")).toHaveText("Response stopped");
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toHaveCount(0);
  const restored = await savedWorkspace(page);
  expect(restored.activeSessionId).toBe(active);
  // A successful subsequent write persists the normalized restored snapshot.
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitemradio", { name: "Local model", exact: true }).click();
  const persisted = await savedWorkspace(page);
  expect(persisted.sessions.find((session: { id: string }) => session.id === active).messages.at(-1).status).toBe("cancelled");
});

test("reload labels a remote stream as detached without claiming server cancellation", async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, state: {
    sessions: [{ id: "remote-example", title: "Remote example", project: "Project Mars", updatedAt: Date.now(), messages: [
      { id: "remote-user", role: "user", content: "Continue the remote task", createdAt: Date.now() },
      { id: "remote-run", role: "assistant", content: "A partial response from the server.", createdAt: Date.now(), status: "running", transport: "remote" },
    ] }], activeSessionId: "remote-example", tasks: [], routines: [], settings: {},
  } })), STORAGE);
  await page.reload();
  await expect(page.locator(".mars-message-status")).toHaveText("Live view disconnected. Server work may continue.");
  await expect(page.getByRole("button", { name: "Retry response", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("menuitemradio", { name: "Local model", exact: true }).click();
  const restored = await savedWorkspace(page);
  expect(restored.sessions[0].messages[1]).toMatchObject({ status: "running", streamState: "detached", transport: "remote" });
});

test("compact composer and new-session choices fit the viewport", async ({ page }) => {
  const composer = page.locator(".mars-composer");
  const box = await composer.boundingBox();
  expect(box?.height).toBeLessThan(90);
  await page.screenshot({ path: "test-results/chat-workspace.png", fullPage: true, caret: "initial" });
  await newConversation(page);
  await expect(page.locator(".mars-welcome-next")).toBeVisible();
  await page.getByRole("button", { name: "Build something", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Mars", exact: true })).toHaveValue("Help me plan something I want to build.");
  await page.screenshot({ path: "test-results/chat-new-session.png", fullPage: true, caret: "initial" });
});
