import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const screenshots = path.resolve(process.cwd(), "test-results", "previews");
const fileStorage = "mars-ui:demo-files:v1";

async function openPanel(page: Page, name: string) {
  await page.locator(".workspace-toolbar").getByRole("button", { name, exact: true }).click();
}

async function capture(page: Page, name: string) {
  await page.mouse.move(650, 900);
  await page.screenshot({ path: path.join(screenshots, `panels-${name}.png`), fullPage: true, caret: "initial" });
}

test.beforeAll(async () => { await mkdir(screenshots, { recursive: true }); });
test.beforeEach(async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator('.mars-chat[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator(".workspace-toolbar")).toBeVisible();
});

test("context cards disclose data and provide keyboard-accessible expand, restore, and close", async ({ page }) => {
  const context = page.locator(".context-panel");
  const contextToggle = context.getByRole("button", { name: /^Context/ });
  await expect(contextToggle).toHaveAttribute("aria-expanded", "false");
  await expect(context.getByRole("switch", { name: "Remote Control requires a runtime connection" })).toBeDisabled();
  const environment = context.locator(".context-card").first();
  expect((await environment.boundingBox())!.height).toBeLessThan(150);
  await capture(page, "context");

  await contextToggle.click();
  await expect(contextToggle).toHaveAttribute("aria-expanded", "true");
  await expect(context.getByText("Conversation text · approximately 4 characters per token")).toBeVisible();
  await context.getByRole("button", { name: "Environment options" }).click();
  await page.getByRole("menuitem", { name: "Runtime connection settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Not connected", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Gateway URL" }).fill("http://localhost:8787");
  await dialog.getByRole("button", { name: "Save URL" }).click();
  await expect(dialog).not.toBeVisible();

  await context.getByRole("button", { name: "Expand context", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Conversation", exact: true })).not.toBeVisible();
  await capture(page, "context-expanded");
  await context.getByRole("button", { name: "Restore context size", exact: true }).click();
  await expect(page.getByRole("region", { name: "Conversation", exact: true })).toBeVisible();
  await context.getByRole("button", { name: "Hide context", exact: true }).click();
  await expect(context).not.toBeVisible();
});

test("file edits survive refresh and produce a reversible diff", async ({ page }) => {
  await openPanel(page, "Files");
  const files = page.locator(".file-panel");
  await expect(files.getByRole("heading", { name: "Project Mars", exact: true })).toBeVisible();
  const tree = files.getByRole("complementary", { name: "Project file tree" });
  expect((await tree.boundingBox())!.x).toBeGreaterThan((await files.getByRole("region", { name: "File editor" }).boundingBox())!.x);
  await capture(page, "files");
  await files.getByRole("button", { name: "Edit source", exact: true }).click();
  const editor = files.getByRole("textbox", { name: "Edit README.md", exact: true });
  const original = await editor.inputValue();
  const marker = "A local change survives refresh.";
  const edited = `${original}\n## Local QA note\n\n${marker}\n`;
  await editor.fill(edited);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}")["README.md"], fileStorage)).toBe(edited);
  await page.reload();
  await openPanel(page, "Files");
  await expect(files.getByText(marker, { exact: true })).toBeVisible();

  await openPanel(page, "Changes");
  const changes = page.locator(".diff-panel");
  await changes.locator(".diff-file-selector").click();
  await page.getByRole("menuitem", { name: "README.md", exact: true }).click();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(changes.locator(".diff-line-add").filter({ hasText: marker })).toBeVisible();
  await changes.getByRole("button", { name: "Restore original file", exact: true }).click();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}")["README.md"], fileStorage)).toBe(original);
  await expect(changes.locator(".diff-line-remove").filter({ hasText: 'activity: "Working in Mars"' })).toBeVisible();
  await expect(changes.locator(".diff-line-add").filter({ hasText: 'activity: "Building Project Mars"' })).toBeVisible();
  await capture(page, "changes");
  await openPanel(page, "Files");
  await expect(files.getByText(marker, { exact: true })).not.toBeVisible();

  await files.getByRole("button", { name: "Expand panel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Conversation", exact: true })).not.toBeVisible();
  await files.getByRole("button", { name: "Restore panel size", exact: true }).click();
  await expect(page.getByRole("region", { name: "Conversation", exact: true })).toBeVisible();
  await files.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(files).not.toBeVisible();
});

test("the local terminal reads fixtures and rejects unsupported commands", async ({ page }) => {
  await openPanel(page, "Terminal");
  const terminal = page.locator(".terminal-panel");
  const input = terminal.getByRole("textbox", { name: "Terminal command", exact: true });
  async function command(value: string) { await input.fill(value); await input.press("Enter"); }
  await command("help");
  await expect(terminal.getByText("Available local demo commands:", { exact: false })).toBeVisible();
  await command("ls docs");
  await expect(terminal.locator("pre").filter({ hasText: "architecture.md\nmemory.md" })).toBeVisible();
  await command("cat README.md");
  await expect(terminal.locator("pre").filter({ hasText: "# Project Mars" })).toBeVisible();
  await command("pwd");
  await expect(terminal.locator("pre").filter({ hasText: "/demo/projects/mars" })).toBeVisible();
  await command("status");
  await expect(terminal.locator("pre").filter({ hasText: "These are local demo task states." })).toBeVisible();
  await command("npm run dev");
  await expect(terminal.getByText("npm: unavailable in this local demo.", { exact: false })).toBeVisible();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("npm run dev");
  await capture(page, "terminal");
  await command("clear");
  await expect(terminal.getByRole("log").locator(".terminal-entry")).toHaveCount(0);
});

test("task approvals and pause states are explicit, persist, and can complete sample steps", async ({ page }) => {
  await openPanel(page, "Background tasks");
  const tasks = page.locator(".task-panel");
  await tasks.getByRole("button", { name: /Verify a durable conversation.*Needs approval/ }).click();
  await expect(tasks.getByText("Your approval is needed", { exact: true })).toBeVisible();
  await capture(page, "task-approval");
  await tasks.getByRole("button", { name: "Approve demo task", exact: true }).click();
  await expect(tasks.locator(".task-state")).toHaveText("Running");
  await tasks.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(tasks.locator(".task-state")).toHaveText("Paused");
  await page.reload();
  await openPanel(page, "Background tasks");
  await tasks.getByRole("button", { name: /Verify a durable conversation.*Paused/ }).click();
  await expect(tasks.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await tasks.getByRole("button", { name: "Resume", exact: true }).click();
  await tasks.getByRole("button", { name: "Complete demo step", exact: true }).click();
  await expect(tasks.locator(".task-step-done")).toHaveCount(1);
  await capture(page, "tasks");
  await tasks.getByRole("button", { name: "Complete demo step", exact: true }).click();
  await tasks.getByRole("button", { name: "Complete demo step", exact: true }).click();
  await expect(tasks.locator(".task-state")).toHaveText("Completed");
  await expect(tasks.locator(".task-step-done")).toHaveCount(3);
});

test("the browser sample navigates, saves notes, and states the live browsing boundary", async ({ page }) => {
  await openPanel(page, "Browser");
  const browser = page.locator(".browser-panel");
  await expect(browser.getByText("A runtime connection is needed for live servers and web browsing.")).toBeVisible();
  await capture(page, "browser-empty");
  await browser.getByRole("button", { name: "Open preview", exact: true }).click();
  await expect(browser.getByRole("heading", { name: "Make room for good work.", exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Connect the agent runtime", exact: true }).click();
  await expect(browser.getByText("3 of 4", { exact: true })).toBeVisible();
  await capture(page, "browser");
  await browser.getByRole("button", { name: "Notes", exact: true }).click();
  const note = browser.getByRole("textbox", { name: "Local sample project notes", exact: true });
  await note.fill("A note saved in the local browser preview.");
  await browser.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(browser.getByRole("heading", { name: "Make room for good work.", exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Go forward", exact: true }).click();
  await expect(note).toHaveValue("A note saved in the local browser preview.");
  await browser.getByRole("textbox", { name: "Preview URL", exact: true }).fill("https://example.com");
  await browser.getByRole("button", { name: "Open preview URL", exact: true }).click();
  await expect(browser.getByRole("heading", { name: "Live browsing isn’t connected", exact: true })).toBeVisible();
  await expect(browser.getByRole("link", { name: "Open in browser", exact: true })).toHaveAttribute("href", "https://example.com");
});

test("side-chat notes survive refresh and can become a full session", async ({ page }) => {
  async function openSideChat() {
    await page.getByRole("button", { name: "View options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Start a side chat", exact: true }).click();
  }
  await openSideChat();
  const sidechat = page.locator(".sidechat-panel");
  await sidechat.getByRole("textbox", { name: "Side chat message", exact: true }).fill("What is the status of the sample tasks?");
  await sidechat.getByRole("button", { name: "Send side chat message", exact: true }).click();
  await expect(sidechat.getByText("There are 2 active sample tasks in this workspace.", { exact: false })).toBeVisible();
  await page.reload();
  await openSideChat();
  await expect(sidechat.getByText("What is the status of the sample tasks?", { exact: true })).toBeVisible();
  await capture(page, "sidechat");
  await sidechat.getByRole("button", { name: "Open side chat as a session", exact: true }).click();
  const conversation = page.getByRole("region", { name: "Conversation", exact: true });
  await expect(conversation.getByText("What is the status of the sample tasks?", { exact: true })).toBeVisible();
  await expect(conversation.getByText("There are 2 active sample tasks in this workspace.", { exact: false })).toBeVisible();
});
