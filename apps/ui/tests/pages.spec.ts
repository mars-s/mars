import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const screenshots = path.resolve(process.cwd(), "test-results", "previews");
const pageErrors = new WeakMap<Page, string[]>();

async function navigation(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  if (!(await nav.isVisible())) {
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  }
  return page.getByRole("navigation", { name: "Main navigation" });
}

async function openRoutines(page: Page) {
  const nav = await navigation(page);
  await nav.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
}

async function openCustomize(page: Page) {
  await (await navigation(page)).getByRole("button", { name: "Customize", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Customize", exact: true })).toBeVisible();
}

async function openArtifacts(page: Page) {
  await (await navigation(page)).getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(screenshots, `pages-${name}.png`), animations: "disabled", caret: "initial" });
}

test.beforeAll(async () => { await mkdir(screenshots, { recursive: true }); });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator('.mars-chat[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo workspace", exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test("routine template, saved edits, enable state, demo run, and deletion", async ({ page }) => {
  test.setTimeout(60_000);
  await openRoutines(page);
  await screenshot(page, "routines");
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  await expect(page.locator(".routine-template")).toHaveCount(8);
  await screenshot(page, "routine-templates");
  await page.locator(".routine-template").filter({ hasText: "System health check" }).click();

  await expect(page.getByLabel("Name", { exact: false })).toHaveValue("System health check");
  await page.getByLabel("Name", { exact: false }).fill("Daily VM review");
  await page.getByLabel("Description", { exact: true }).fill("Review the VM before the day starts.");
  await page.getByLabel("Instructions", { exact: false }).fill("Review service logs. Summarize any failures and ask before restarting services.");
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Cron expression", { exact: true }).fill("invalid");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.getByLabel("Cron expression", { exact: true }).fill("0 9 * * 1-5");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Weekly", exact: true }).click();
  await page.getByLabel("Day of the week", { exact: true }).selectOption("Tuesday");
  await page.getByLabel("Run time", { exact: true }).fill("10:15");
  await screenshot(page, "routine-editor");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  let routine = page.locator(".routine-list-row").filter({ hasText: "Daily VM review" });
  await expect(routine).toBeVisible();
  await expect(routine).toContainText("Every Tuesday at 10:15 AM");
  await expect(routine.getByRole("switch")).toBeChecked();
  await routine.getByRole("switch").click();
  await expect(routine.getByRole("switch")).not.toBeChecked();

  await page.reload();
  await openRoutines(page);
  routine = page.locator(".routine-list-row").filter({ hasText: "Daily VM review" });
  await expect(routine.getByRole("switch")).not.toBeChecked();
  await routine.getByRole("button", { name: "Actions for Daily VM review", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit routine", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Review the VM before the day starts.");
  await expect(page.getByLabel("Instructions", { exact: false })).toHaveValue("Review service logs. Summarize any failures and ask before restarting services.");
  await expect(page.getByLabel("Day of the week", { exact: true })).toHaveValue("Tuesday");
  await page.getByLabel("Name", { exact: false }).fill("VM review updated");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();

  routine = page.locator(".routine-list-row").filter({ hasText: "VM review updated" });
  await routine.getByRole("button", { name: "Actions for VM review updated", exact: true }).click();
  await page.getByRole("menuitem", { name: "Run now", exact: true }).click();
  await expect(page.locator(".workspace-title")).toContainText("VM review updated · demo run");
  await expect(page.getByText("This is a demo run of your saved routine.", { exact: false })).toBeVisible();
  await expect(page.getByText("No tools were executed and no external services were contacted.", { exact: false })).toBeVisible();

  await openRoutines(page);
  routine = page.locator(".routine-list-row").filter({ hasText: "VM review updated" });
  await expect(routine).toContainText("Last demo run just now");
  await routine.getByRole("button", { name: "Actions for VM review updated", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete routine", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete routine", exact: true }).click();
  await expect(page.locator(".routine-list-row").filter({ hasText: "VM review updated" })).toHaveCount(0);
});

test("skills can be added, customized, restored after reload, and removed", async ({ page }) => {
  await openCustomize(page);
  await screenshot(page, "customize");
  await page.getByRole("button", { name: "Add Finance to workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Finance from workspace", exact: true })).toBeVisible();
  await page.locator(".customize-card").filter({ hasText: "Finance" }).locator(".customize-card-main").click();
  const dialog = page.getByRole("dialog", { name: "Finance", exact: true });
  await dialog.getByLabel("Instructions", { exact: true }).fill("Keep every calculation traceable and explain all assumptions.");
  await dialog.getByRole("button", { name: "Save instructions", exact: true }).click();
  await page.getByRole("tab", { name: "Yours", exact: true }).click();
  await expect(page.locator(".customize-card").filter({ hasText: "Finance" })).toHaveCount(1);

  await page.reload();
  await openCustomize(page);
  await page.getByRole("tab", { name: "Yours", exact: true }).click();
  await page.locator(".customize-card").filter({ hasText: "Finance" }).locator(".customize-card-main").click();
  await expect(page.getByRole("dialog").getByLabel("Instructions", { exact: true })).toHaveValue("Keep every calculation traceable and explain all assumptions.");
  await page.getByRole("dialog").getByRole("button", { name: "Remove from workspace", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".customize-card").filter({ hasText: "Finance" })).toHaveCount(0);
});

test("connector search and a custom configuration persist without implying authorization", async ({ page }) => {
  await openCustomize(page);
  await page.getByRole("tab", { name: "Connectors", exact: true }).click();
  await page.getByLabel("Search connectors", { exact: true }).fill("Hindsight");
  await expect(page.locator(".customize-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Add Hindsight to workspace", exact: true }).click();
  await expect(page.getByText("Adding a connector does not connect an external account.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add connector", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Team knowledge");
  await dialog.getByLabel("Description", { exact: true }).fill("Reference notes for the Mars project.");
  await dialog.getByLabel("Instructions", { exact: true }).fill("Read project notes and retain source links. Ask before changing records.");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Yours", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".customize-card").filter({ hasText: "Team knowledge" })).toHaveCount(1);

  await page.reload();
  await openCustomize(page);
  await page.getByRole("tab", { name: "Connectors", exact: true }).click();
  await page.getByRole("tab", { name: "Yours", exact: true }).click();
  await page.locator(".customize-card").filter({ hasText: "Team knowledge" }).locator(".customize-card-main").click();
  await expect(page.getByRole("dialog").getByLabel("Access instructions", { exact: true })).toHaveValue("Read project notes and retain source links. Ask before changing records.");
  await expect(page.getByRole("dialog")).toContainText("Account authorization is not configured in this demo.");
});

test("artifacts support preview, a real file download, and persistent user-file CRUD", async ({ page }) => {
  test.setTimeout(60_000);
  await openArtifacts(page);
  await screenshot(page, "artifacts");
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await expect(page.locator(".artifact-tile")).toHaveCount(2);
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.locator(".artifact-tile")).toHaveCount(2);
  await page.locator(".artifact-tile").filter({ hasText: "mars-architecture.md" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Project Mars", exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("dialog").getByRole("button", { name: "Download", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("mars-architecture.md");
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!, "utf8")).toContain("# Project Mars");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  await page.getByRole("dialog").getByLabel("File name", { exact: true }).fill("qa-notes.md");
  await page.getByRole("dialog").getByRole("textbox", { name: "Content", exact: true }).fill("# QA notes\n\nKeep a useful record of the work.");
  await page.getByRole("dialog").getByRole("button", { name: "Create artifact", exact: true }).click();
  await expect(page.locator(".artifact-tile").filter({ hasText: "qa-notes.md" })).toHaveCount(1);
  await page.reload();
  await openArtifacts(page);
  await page.locator(".artifact-tile").filter({ hasText: "qa-notes.md" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByRole("dialog").getByLabel("File name", { exact: true }).fill("review-notes.md");
  await page.getByRole("dialog").getByRole("textbox", { name: "Content", exact: true }).fill("# Reviewed notes\n\nThe updated artifact content.");
  await page.getByRole("dialog").getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".artifact-tile").filter({ hasText: "qa-notes.md" })).toHaveCount(0);
  await page.locator(".artifact-tile").filter({ hasText: "review-notes.md" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Reviewed notes", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.locator(".artifact-source")).toContainText("# Reviewed notes");
  await page.getByRole("dialog").getByRole("button", { name: "Delete artifact", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete file", exact: true }).click();
  await expect(page.locator(".artifact-tile").filter({ hasText: "review-notes.md" })).toHaveCount(0);
  await page.reload();
  await openArtifacts(page);
  await expect(page.locator(".artifact-tile").filter({ hasText: "review-notes.md" })).toHaveCount(0);
});

test("mobile customization and routine editor remain contained and usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCustomize(page);
  await expect(page.locator(".customize-card").first()).toBeVisible();
  await screenshot(page, "customize-mobile");
  expect(await page.locator(".pages-root").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await openRoutines(page);
  await page.getByRole("button", { name: "New routine", exact: true }).click();
  await page.getByRole("menuitem", { name: "VM routine", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: false })).toBeVisible();
  await page.getByLabel("Name", { exact: false }).fill("Mobile routine");
  await page.getByLabel("Instructions", { exact: false }).fill("Prepare a short project summary.");
  await screenshot(page, "routine-editor-mobile");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".routine-list-row").filter({ hasText: "Mobile routine" })).toBeVisible();
  expect(await page.locator(".pages-root").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
