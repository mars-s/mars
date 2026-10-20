import assert from "node:assert/strict";
import test from "node:test";
import { browserExecutable, uiBaseURL } from "./browser-options.mjs";

test("browser checks use an explicit override, the installed browser, then the optional shared browser", () => {
  const options = { env: {}, installed: "/installed/chromium", home: "/fixture", exists: () => true };
  assert.equal(browserExecutable({ ...options, env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/custom/chrome" } }), "/custom/chrome");
  assert.equal(browserExecutable(options), "/installed/chromium");
  assert.equal(browserExecutable({ ...options, exists: (file) => file.includes("mars-dev-tools") }), "/fixture/.local/share/mars-dev-tools/browsers/chromium-1234/chrome-linux64/chrome");
  assert.equal(browserExecutable({ ...options, exists: () => false }), undefined);
});

test("browser checks follow an explicit URL or the chosen UI port", () => {
  assert.equal(uiBaseURL({}), "http://127.0.0.1:3082/");
  assert.equal(uiBaseURL({ MARS_UI_PORT: "4090" }), "http://127.0.0.1:4090/");
  assert.equal(uiBaseURL({ MARS_UI_BASE_URL: "https://fixture.example", MARS_UI_PORT: "4090" }), "https://fixture.example");
});
