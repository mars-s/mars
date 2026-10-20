import { defineConfig } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./tests/browser-options.mjs";

const baseURL = uiBaseURL();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1512, height: 949 },
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: browserLaunchOptions(),
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
