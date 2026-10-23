// Settings, Lanes in the browser (docs/LANES.md), against routed fixtures: lanes with their
// state, preview link and note, reordering the queue, pausing, and starting a preview.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const posts = [];
const lane = (id, title, state, extra = {}) => ({ id, title, state, branch: "lane/" + id, worktree: "/w/" + id, conversationId: null,
  queuePosition: null, preview: null, note: "", changed: ["apps/ui/a.tsx"], mergedCommit: null, updatedAt: "", ...extra });
let data = {
  lanes: [
    lane("first-1a2b", "Tasks pane", "queued", { queuePosition: 1 }),
    lane("second-3c4d", "Resizable sidebar", "queued", { queuePosition: 2, preview: { url: "https://box.example:8601/", state: "running" } }),
    lane("third-5e6f", "Voice tweaks", "blocked", { note: "It conflicts with main in apps/ui/lib/pi/voice.ts." }),
  ],
  queue: ["first-1a2b", "second-3c4d"], paused: true, main: "main", previewsMax: 2,
};
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/lanes")) {
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/lanes/order") {
        data = { ...data, queue: body.ids, lanes: data.lanes.map((l) => (body.ids.includes(l.id) ? { ...l, queuePosition: body.ids.indexOf(l.id) + 1 } : l)) };
        data.lanes.sort((a, b) => (a.queuePosition ?? 9) - (b.queuePosition ?? 9));
      }
      if (url.pathname === "/api/lanes/pause") data = { ...data, paused: body.paused };
      if (url.pathname.endsWith("/preview"))
        data = { ...data, lanes: data.lanes.map((l) => (url.pathname.includes(l.id) ? { ...l, preview: { url: "https://box.example:8602/", state: "running" } } : l)) };
    }
    return route.fulfill({ json: data });
  }
  if (url.pathname === "/api/state")
    return route.fulfill({ json: {
      runtime: "Pi Durable 1.3.0", conversationId: 1, selectedConversationId: 1,
      auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }],
      view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
    } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
const checks = [];
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await page.getByRole("tab", { name: "Lanes", exact: true }).click();
  const panel = page.locator(".lane-settings");
  await panel.getByText("Tasks pane").waitFor();
  const rows = panel.locator(".lane-row");
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).innerText(), /1\s*Tasks pane[\s\S]*Waiting to merge/);
  assert.equal(await panel.getByRole("link", { name: "Open preview" }).getAttribute("href"), "https://box.example:8601/");
  assert.match(await rows.nth(2).innerText(), /Blocked[\s\S]*conflicts with main in apps\/ui\/lib\/pi\/voice\.ts/);
  checks.push("lanes listed");

  await panel.getByRole("button", { name: "Move Resizable sidebar up" }).click();
  await page.waitForFunction(() => document.querySelector(".lane-row strong")?.textContent?.includes("Resizable sidebar"));
  assert.deepEqual(posts.at(-1), { path: "/api/lanes/order", body: { ids: ["second-3c4d", "first-1a2b"] } });
  assert.equal(await panel.getByRole("button", { name: "Move Resizable sidebar up" }).isDisabled(), true, "first cannot move up");
  checks.push("reorder");

  const auto = panel.getByRole("checkbox", { name: "Merge automatically" });
  assert.equal(await auto.isChecked(), false, "paused shows unchecked");
  // It shows the host's answer, so it flips once the request returns.
  await auto.click();
  await page.waitForFunction(() => document.querySelector('.lane-pause input')?.checked === true);
  assert.deepEqual(posts.at(-1), { path: "/api/lanes/pause", body: { paused: false } });
  checks.push("pause");

  await rows.filter({ hasText: "Tasks pane" }).getByRole("button", { name: "Preview" }).click();
  await panel.locator('a[href="https://box.example:8602/"]').waitFor();
  assert.deepEqual(posts.at(-1), { path: "/api/lanes/first-1a2b/preview", body: { on: true } });
  checks.push("preview");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, error: String(error?.message || error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
