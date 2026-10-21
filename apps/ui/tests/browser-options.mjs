import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Prefer the pinned Playwright install. Keep Bot Box's shared browser usable
// without requiring that private directory on another machine.
export function browserExecutable({ env = process.env, installed = chromium.executablePath(), home = homedir(), exists = existsSync } = {}) {
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (exists(installed)) return installed;
  const shared = join(home, ".local/share/mars-dev-tools/browsers/chromium-1234/chrome-linux64/chrome");
  return exists(shared) ? shared : undefined;
}

export function browserLaunchOptions() {
  return {
    executablePath: browserExecutable(),
    headless: true,
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), "--disable-extensions"],
  };
}

export function uiBaseURL(env = process.env) {
  return env.MARS_UI_BASE_URL || env.MARS_UI_URL || `http://127.0.0.1:${env.MARS_UI_PORT || "3082"}/`;
}

/**
 * Wait until the live workspace is hydrated. The header is server-rendered, so a click
 * that lands before React attaches its handlers is silently lost. Every workbench check
 * calls this after loading the page.
 */
export async function waitForHydration(page) {
  await page.getByRole("textbox", { name: "Message Mars" }).waitFor({ timeout: 120000 });
  await page.waitForFunction(
    () => Object.keys(document.querySelector(".live-workbench-toggle") ?? {}).some((key) => key.startsWith("__reactProps")),
    null,
    { timeout: 60000 },
  );
}
