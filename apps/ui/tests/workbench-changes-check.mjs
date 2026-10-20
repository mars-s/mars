import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";

// Fixture-only: the Changes routes are answered here with labelled data, independent of a host.
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/workbench-changes";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const state = {
  runtime: "Pi Durable 1.3.0",
  providerReady: true,
  conversationId: "1",
  selectedConversationId: "1",
  conversationTitle: "Changes fixture",
  conversations: [{ id: "1", title: "Changes fixture" }],
  auth: { connected: true, state: "connected", events: [] },
  models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["low", "medium"] }],
  thinkingLevel: "medium",
  extensions: [],
  view: {
    entries: [{ id: 1, model: [{ role: "user", content: [{ type: "text", text: "Show me the changes" }] }] }],
    docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } } },
  },
};
const greeting = Array.from({ length: 6 }, (_, n) => `+  const fixtureLine${n} = ${n};`);
const changes = {
  repo: "mars-fixture",
  branch: "fixture/workbench",
  truncated: false,
  files: [
    { path: "FIXTURE.md", status: "?", added: 2, removed: 0, binary: false },
    { path: "assets/fixture-logo.png", status: "M", added: 0, removed: 0, binary: true },
    { path: "docs/old-fixture.md", status: "D", added: 0, removed: 1, binary: false },
    { path: "src/fixture-greeting.ts", status: "M", added: 8, removed: 1, binary: false },
  ],
  patch: [
    "diff --git a/src/fixture-greeting.ts b/src/fixture-greeting.ts",
    "--- a/src/fixture-greeting.ts",
    "+++ b/src/fixture-greeting.ts",
    "@@ -1,3 +1,10 @@",
    " export function greet(name: string) {",
    '-  return "Hello " + name;',
    "+  // Fixture change for the workbench preview.",
    ...greeting,
    "+  return `Hello, ${name}`;",
    " }",
    "diff --git a/docs/old-fixture.md b/docs/old-fixture.md",
    "--- a/docs/old-fixture.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-Fixture page that was removed.",
    "diff --git a/assets/fixture-logo.png b/assets/fixture-logo.png",
    "Binary files a/assets/fixture-logo.png and b/assets/fixture-logo.png differ",
    "diff --git a/FIXTURE.md b/FIXTURE.md",
    "--- /dev/null",
    "+++ b/FIXTURE.md",
    "@@ -0,0 +1,2 @@",
    "+# Fixture data",
    "+Untracked file shown as an addition.",
    "",
  ].join("\n"),
};
let changeRequests = 0;
const routes = {
  "/api/state": () => state,
  "/api/workbench/capabilities": () => ({
    tools: {
      changes: { available: true },
      files: { available: false, reason: "Fixture: not part of this check" },
      terminal: { available: false, reason: "Fixture: not part of this check" },
      "side-chat": { available: true },
      page: { available: false, reason: "Fixture: not part of this check" },
      browser: { available: false, reason: "Fixture: not part of this check" },
    },
  }),
  "/api/workbench/suggestions": () => ({ suggestions: [] }),
  "/api/workbench/repos": () => ({
    repos: [
      { path: "mars-fixture", branch: "fixture/workbench", ahead: 2, behind: 1, dirty: true },
      { path: "notes", branch: "main", ahead: 0, behind: 0, dirty: false },
    ],
  }),
  "/api/workbench/changes": (url) => {
    changeRequests++;
    const repo = url.searchParams.get("repo");
    return repo === "notes" ? { repo, branch: "main", files: [], patch: "", truncated: false } : changes;
  },
};

async function open(viewport, theme) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addInitScript((value) => {
    localStorage.removeItem("mars-workbench-v1");
    localStorage.setItem("mars-live-theme", value);
  }, theme);
  const tab = await context.newPage();
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const answer = routes[url.pathname];
    return route.fulfill({ json: answer ? answer(url) : { accepted: true } });
  });
  await tab.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await tab.getByRole("textbox", { name: "Message Mars" }).waitFor();
  await tab.getByRole("button", { name: "Open workbench" }).click();
  await tab.getByRole("region", { name: "Workbench" }).getByRole("button", { name: "Changes", exact: true }).click();
  await tab.getByRole("heading", { name: "4 files changed" }).waitFor();
  return tab;
}

try {
  for (const theme of ["dark", "light"]) {
    const desktop = await open({ width: 1440, height: 900 }, theme);
    const review = desktop.getByRole("region", { name: "Changes in mars-fixture" });
    assert.equal(await desktop.getByRole("combobox", { name: "Repository" }).inputValue(), "mars-fixture");
    await desktop.getByText("fixture/workbench").first().waitFor();
    await desktop.getByText("2 ahead").waitFor({ state: "attached" });
    await desktop.getByText("1 behind").waitFor({ state: "attached" });
    const rows = review.locator(".wb-review-file");
    assert.deepEqual(
      await rows.evaluateAll((items) => items.map((item) => item.querySelector(".wb-review-path").textContent)),
      ["FIXTURE.md", "assets/fixture-logo.png", "docs/old-fixture.md", "src/fixture-greeting.ts"],
    );
    assert.match(await review.locator(".wb-review-head").innerText(), /\+10\s*−2/, "totals sum the host counts");
    await review.getByRole("button", { name: "Untracked: FIXTURE.md, 2 added, 0 removed" }).waitFor();
    await review.getByRole("button", { name: "Deleted: docs/old-fixture.md, 0 added, 1 removed" }).waitFor();
    const binary = review.getByRole("button", { name: "Modified: assets/fixture-logo.png, binary" });
    assert.match(await binary.innerText(), /Binary/);
    assert.equal(await binary.getAttribute("aria-expanded"), "false", "binary files start closed");

    // The first three text files open by default with the 21st diff card.
    await desktop.locator(".an-edit-tool-card").first().waitFor();
    assert.equal(await review.locator(".an-edit-tool-card").count(), 3);
    const greetingCard = review.locator(".wb-review-row", { hasText: "fixture-greeting.ts" }).locator(".an-edit-tool-card");
    await greetingCard.getByText("const fixtureLine5 = 5;").waitFor();
    assert.equal(await greetingCard.getByText("Edited fixture-greeting.ts").isVisible(), false, "the row, not the card, names the file");

    if (theme === "dark") {
      await desktop.screenshot({ path: `${evidence}/desktop-dark.png` });
      const toggleRow = review.getByRole("button", { name: /src\/fixture-greeting\.ts/ });
      await toggleRow.click();
      assert.equal(await toggleRow.getAttribute("aria-expanded"), "false", "a file row collapses");
      await binary.click();
      await review.getByText("Binary file. Its contents are not shown.").waitFor();

      const before = changeRequests;
      await desktop.getByRole("button", { name: "Refresh changes" }).click();
      await desktop.waitForFunction(() => !document.querySelector(".wb-changes[aria-busy='true']"));
      assert.ok(changeRequests > before, "refresh refetches the change set");

      await desktop.getByRole("combobox", { name: "Repository" }).selectOption("notes");
      await desktop.getByText("No changes. The working tree matches main.").waitFor();
      assert.equal(await desktop.getByRole("tab", { name: /Changes · notes/ }).count(), 1, "the tab keeps the chosen repo");
      assert.equal(await desktop.getByRole("button", { name: /^(Accept|Reject)/ }).count(), 0, "read-only: no accept or reject");
    } else {
      await desktop.screenshot({ path: `${evidence}/desktop-light.png` });
    }
    await desktop.context().close();

    const mobile = await open({ width: 390, height: 844 }, theme);
    await mobile.locator(".an-edit-tool-card").first().waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no page overflow at 390px");
    const overflow = await mobile.locator(".wb-review-file").evaluateAll((items) => items.filter((item) => item.scrollWidth > item.clientWidth + 1).length);
    assert.equal(overflow, 0, "file rows fit at 390px");
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}.png` });
    await mobile.context().close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS workbench changes pane: repo picker, branch ahead/behind, file list with status and counts, binary flagged, 21st diff cards, collapse, refresh, empty repo, read-only, 390px without overflow, dark and light");
} finally {
  await browser.close();
}
