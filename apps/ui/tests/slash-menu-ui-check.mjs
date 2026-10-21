// The "/" skill menu in the composer, against routed fixtures: typing "/" lists skills, typing
// filters them, arrows and Enter choose without sending, Escape closes, and a space ends it.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const posts = [];
const skills = [
  { name: "grill-me", description: "A relentless interview to sharpen a plan.", source: "agents" },
  { name: "grill-with-docs", description: "Interview that also writes docs.", source: "agents" },
  { name: "tdd", description: "Write a failing test first.", source: "mars" },
  { name: "how", description: "Explain how code works (grill-free).", source: "agents" },
];
await page.route("**/api/**", (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "POST") posts.push(url.pathname);
  if (url.pathname === "/api/skills") return route.fulfill({ json: { total: skills.length, skills } });
  if (url.pathname === "/api/state")
    return route.fulfill({ json: { runtime: "Pi Durable 1.3.0", conversationId: 1, auth: { connected: true, state: "connected", events: [] }, providerReady: true, models: [{ id: "gpt-6-luna", name: "Luna" }], extensions: [], conversations: [{ id: 1, title: "Main" }], view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } } } });
  return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
});
try {
  await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await waitForHydration(page);
  const input = page.getByRole("textbox", { name: "Message Mars" });
  await input.fill("/");
  const list = page.getByRole("listbox", { name: "Skills" });
  await list.waitFor();
  assert.equal(await list.getByRole("option").count(), 4);
  await input.fill("/gr");
  await page.waitForFunction(() => document.querySelectorAll('[role="listbox"] [role="option"]').length === 3);
  const names = await list.getByRole("option").allInnerTexts();
  assert.ok(names[0].startsWith("/grill-me") && names[1].startsWith("/grill-with-docs") && names[2].startsWith("/how"), "name matches first, then description matches: " + names);
  await input.press("ArrowDown");
  assert.equal(await list.getByRole("option", { selected: true }).innerText().then((t) => t.split("\n")[0]), "/grill-with-docs");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "/grill-with-docs ");
  await list.waitFor({ state: "detached" });
  assert.ok(!posts.includes("/api/chat"), "choosing a skill does not send");
  await input.fill("/td");
  await list.waitFor();
  await input.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.equal(await input.inputValue(), "/td");
  await input.fill("/tdd please");
  assert.equal(await list.count(), 0, "a space ends the menu");
  await list.count();
  await input.fill("/");
  await list.getByRole("option", { name: /\/tdd/ }).click();
  assert.equal(await input.inputValue(), "/tdd ");
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, checks: ["slash lists skills", "filter and rank", "arrow and Enter choose without sending", "Escape closes", "space ends", "click chooses"] }));
} finally {
  await browser.close();
}
