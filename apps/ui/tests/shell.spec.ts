import { expect, test } from "@playwright/test";

test("workspace renders on the server and stays within the viewport", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("textbox", { name: "Message Mars" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("search, rename and archive preserve the selected conversation", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search sessions and commands" });
  await search.fill("Memory & continuity");
  await search.press("Enter");
  await expect(page.locator(".workspace-title")).toContainText("Memory & continuity");
  await page.locator(".workspace-title").click();
  await page.getByRole("menuitem", { name: "Rename session" }).click();
  await page.getByRole("textbox", { name: "Session name" }).fill("Memory decisions");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".workspace-title")).toContainText("Memory decisions");
  await page.reload();
  await expect(page.locator(".workspace-title")).toContainText("Memory decisions");
  await page.locator(".workspace-title").click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await expect(page.locator(".desktop-sidebar .session-title-text", { hasText: "Memory decisions" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Mars" })).toBeVisible();
});

test("theme and keyboard sidebar preferences work without losing chat", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+b");
  await expect(page.locator(".desktop-sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.locator(".desktop-sidebar")).toBeVisible();
  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog", { name: "Workspace settings" })).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("textbox", { name: "Message Mars" })).toBeVisible();
});

test("mobile navigation and panel tools are reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message Mars" })).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  const navigation = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Customize", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Customize", exact: true })).toBeVisible();
  await expect(navigation).not.toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await navigation.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "terminal panel" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Mars" })).toBeVisible();
});
