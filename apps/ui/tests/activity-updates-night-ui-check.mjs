// Activity and updates in the browser, against routed fixtures: a codemode script that failed
// after a good nested call shows a Failed row with its error and counts as failed; a failed edit
// shows its error and no "Edited" diff card; Settings, Updates polls GET /api/update every two
// seconds while an update runs, not back to back.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let updateGets = 0;
const running = {
  status: null,
  head: "c1787bd53fc8",
  settings: { auto: false },
  running: { phase: "preparing", step: "build", steps: [{ name: "build", status: "running", detail: "" }] },
  last: null,
};
const state = {
  runtime: "Pi Durable",
  conversationId: "1",
  auth: { connected: true },
  providerReady: true,
  models: [],
  extensions: [],
  conversations: [{ id: "1", title: "Night fixture" }],
  view: {
    docs: { "pi.agent": { model: { modelId: "Luna" } }, "pi.live": {} },
    entries: [
      {
        id: 1,
        model: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "code", name: "codemode", arguments: { code: "await tools.host_exec({command:'ls'}); throw Error('boom')" } },
              { type: "toolCall", id: "edit", name: "edit", arguments: { path: "a.ts", oldText: "foo", newText: "bar" } },
            ],
          },
        ],
      },
      {
        id: 2,
        model: [
          {
            role: "toolResult",
            toolCallId: "code",
            content: "Error: boom",
            isError: true,
            details: { calls: [{ id: 1, name: "host_exec", args: '{"command":"ls"}', status: "ok", durationMs: 5 }] },
          },
          { role: "toolResult", toolCallId: "edit", content: "Could not find the exact text in a.ts", isError: true },
        ],
      },
      { id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "Both steps failed." }] }] },
    ],
  },
};
await page.route("**/api/**", (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/update" && request.method() === "GET") {
    updateGets++;
    return route.fulfill({ json: running });
  }
  if (url.pathname === "/api/state") return route.fulfill({ json: state });
  return route.fulfill({ json: { conversations: [{ id: "1", title: "Night fixture" }], rootId: "1" } });
});
try {
  await page.goto(new URL("/?conversation=1", uiBaseURL()).href, { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const activity = page.locator("details.live-activity").first();
  await activity.locator(".live-activity-failed", { hasText: "2 failed" }).waitFor();
  await activity.locator(":scope > summary").click();
  const codeRow = activity.locator("li", { hasText: "Run code" });
  assert.equal(await codeRow.locator(".live-tool-state").textContent(), "Failed");
  await codeRow.locator("summary").click();
  await codeRow.getByText("Error: boom", { exact: true }).waitFor();
  const editRow = activity.locator("li", { hasText: "Edit file" });
  assert.equal(await editRow.locator(".live-tool-state").textContent(), "Failed");
  await editRow.locator("summary").click();
  await editRow.getByText("Could not find the exact text in a.ts", { exact: true }).waitFor();
  assert.equal(await page.getByText("Edited a.ts", { exact: false }).count(), 0, "no diff card claims the edit happened");

  await page.getByRole("button", { name: "Open settings" }).first().click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.locator(".update-settings").getByText("Updating Mars…").waitFor();
  await page.waitForTimeout(500);
  const before = updateGets;
  await page.waitForTimeout(5000);
  const polls = updateGets - before;
  assert.ok(polls >= 1 && polls <= 4, `about one GET /api/update every two seconds while updating, saw ${polls} in five seconds`);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, polls, checks: ["failed codemode row and error", "failed count", "failed edit error without diff", "update polling every two seconds"] }));
} finally {
  await browser.close();
}
