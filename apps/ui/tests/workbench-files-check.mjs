import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";

// Fixture-only: every workbench route is answered here so the check is independent of a host.
const evidence = process.env.MARS_EVIDENCE_DIR || "/tmp/mars-workbench-evidence/files";
await mkdir(evidence, { recursive: true });

function png(size) {
  const crc = (bytes) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x9c)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(24);
const now = Date.parse("2026-10-20T09:30:00+11:00");
const longScript = Array.from({ length: 120 }, (_, n) => `echo "fixture step ${n + 1}"`).join("\n");
const texts = {
  "README.md": "# Fixture workspace\n\nThis is **fixture data**.\n\n- [Release notes](notes/release.md)\n- [External](https://example.com/)\n\n| Item | State |\n| --- | --- |\n| Files | Fixture |\n\n![Mark](assets/mark.png)\n\n![Remote](https://example.com/tracker.png)\n",
  "notes/release.md": "# Release plan\n\n1. Merge lanes.\n",
  "notes/ideas.txt": "idea one\nidea two\n",
  "scripts/deploy.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${longScript}\n`,
  ".env.example": "MARS_PI_TOKEN=\n",
};
const binaries = { "assets/mark.png": PNG, "assets/archive.zip": 48 * 1024 };
const dirs = ["", "assets", "notes", "scripts", "node_modules"];
const listing = (dir) => {
  const prefix = dir ? `${dir}/` : "";
  const names = new Map();
  for (const path of [...dirs.filter(Boolean), ...Object.keys(texts), ...Object.keys(binaries)]) {
    if (!path.startsWith(prefix) || path === dir) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    if (!names.has(name)) names.set(name, rest.length || dirs.includes(prefix + name) ? "dir" : "file");
  }
  const entries = [...names].map(([name, type]) => ({ name, type, size: type === "dir" ? 0 : (texts[prefix + name]?.length ?? 1), modified: now, hidden: name.startsWith(".") }));
  if (!dir) entries.push({ name: "escape", type: "link", size: 0, modified: now, hidden: false, target: { type: "outside" } });
  return entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
};
const requests = [];
function answer(url) {
  const path = url.searchParams.get("path") || "";
  requests.push(url.pathname + url.search);
  switch (url.pathname) {
    case "/api/state":
      return { json: state };
    case "/api/workbench/capabilities":
      return { json: { tools: { files: { available: true }, "side-chat": { available: true } } } };
    case "/api/workbench/suggestions":
      return { json: { suggestions: [] } };
    case "/api/workbench/files":
      return dirs.includes(path) ? { json: { path, entries: listing(path), truncated: false } } : { status: 404, json: { error: "Fixture: no such folder" } };
    case "/api/workbench/file":
      if (path in texts) return { json: { path, size: texts[path].length, modified: now, kind: "text", text: texts[path], truncated: false } };
      if (path === "assets/mark.png") return { json: { path, size: PNG.length, modified: now, kind: "image", mime: "image/png" } };
      if (path === "assets/archive.zip") return { json: { path, size: binaries[path], modified: now, kind: "binary" } };
      return { status: 404, json: { error: "Fixture: no such file" } };
    case "/api/workbench/raw":
      return path === "assets/mark.png" ? { body: PNG, contentType: "image/png" } : { status: 415, json: { error: "Fixture: not an image" } };
    case "/api/workbench/search": {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const results = Object.keys(texts).filter((item) => item.split("/").pop().toLowerCase().includes(q)).map((item) => ({ path: item, type: "file" }));
      return { json: { query: q, results, truncated: false, timedOut: false } };
    }
    default:
      return { json: { accepted: true } };
  }
}
const state = {
  runtime: "Pi Durable 1.3.0",
  providerReady: true,
  conversationId: "1",
  selectedConversationId: "1",
  conversationTitle: "Workspace tour",
  conversations: [{ id: "1", title: "Workspace tour" }],
  auth: { connected: true, state: "connected", events: [] },
  models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["low", "medium"] }],
  thinkingLevel: "medium",
  extensions: [],
  view: { entries: [{ id: 1, model: [{ role: "user", content: [{ type: "text", text: "Show me the workspace" }] }] }], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } } } },
};

const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const external = [];
async function open(viewport, theme) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  if (theme) await context.addInitScript((value) => localStorage.setItem("mars-live-theme", value), theme);
  const tab = await context.newPage();
  tab.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "example.com") {
      external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const { status = 200, json, body, contentType } = answer(url);
    return json === undefined ? route.fulfill({ status, body, contentType }) : route.fulfill({ status, json });
  });
  await tab.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
  await tab.getByRole("textbox", { name: "Message Mars" }).waitFor();
  return tab;
}
async function openFiles(tab) {
  await tab.getByRole("button", { name: "Open workbench" }).click();
  const tile = tab.getByRole("region", { name: "Workbench" }).getByRole("button", { name: /^Files/ });
  await tab.waitForFunction(() => document.querySelector(".wb-tool:not(:disabled)"));
  await tile.click();
  await tab.getByRole("tree", { name: "Workspace files" }).waitFor();
  await tab.getByRole("treeitem", { name: "README.md" }).waitFor();
}
const item = (tab, name) => tab.getByRole("treeitem", { name, exact: true });
const noOverflow = (tab) => tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

try {
  const desktop = await open({ width: 1440, height: 900 });
  await openFiles(desktop);
  const treeBox = await desktop.getByRole("tree").boundingBox();
  const viewerBox = await desktop.locator(".wb-files-viewer").boundingBox();
  assert.ok(viewerBox.x >= treeBox.x + treeBox.width - 1 && Math.abs(viewerBox.y - treeBox.y) < 2, "tree and viewer sit side by side at the default width");
  const names = await desktop.getByRole("treeitem").allTextContents();
  assert.deepEqual(names.slice(0, 4), ["assets", "node_modules", "notes", "scripts"], "folders first");
  assert.ok(names.includes(".env.example") && names.includes("escape"), "dotfiles and links are listed");
  assert.equal(await item(desktop, "escape").getAttribute("aria-disabled"), "true", "a link out of the workspace cannot be opened");
  await desktop.getByText("Choose a file to view it.").waitFor();

  // Keyboard: one tab stop, arrows move, Right expands, Enter opens.
  await item(desktop, "assets").focus();
  await desktop.keyboard.press("ArrowDown");
  await desktop.keyboard.press("ArrowDown");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "notes");
  await desktop.keyboard.press("ArrowRight");
  await item(desktop, "release.md").waitFor();
  assert.equal(await item(desktop, "notes").getAttribute("aria-expanded"), "true");
  await desktop.keyboard.press("ArrowRight");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "ideas.txt", "Right on an open folder moves to its first child");
  await desktop.keyboard.press("Enter");
  const code = desktop.getByRole("region", { name: "ideas.txt contents" });
  await code.waitFor();
  assert.equal(await code.locator(".wb-files-gutter").textContent(), "1\n2", "line numbers");
  assert.equal(await desktop.getByRole("tree").locator("[tabindex='0']").count(), 1, "the tree has one tab stop");
  await desktop.keyboard.press("ArrowLeft");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "notes", "Left returns to the parent folder");
  await desktop.keyboard.press("ArrowLeft");
  assert.equal(await item(desktop, "release.md").count(), 0, "Left collapses");

  // Markdown renders, links to workspace files open in the pane, remote images never load.
  await item(desktop, "README.md").click();
  await desktop.getByRole("heading", { name: "Fixture workspace" }).waitFor();
  await desktop.locator(".wb-files-md table").waitFor();
  const mark = desktop.locator(".wb-files-md img[alt='Mark']");
  await mark.waitFor();
  await desktop.waitForFunction(() => document.querySelector(".wb-files-md img[alt='Mark']")?.naturalWidth === 24);
  assert.equal(await mark.getAttribute("src"), "/api/workbench/raw?path=assets%2Fmark.png");
  await desktop.getByText("Image: Remote").waitFor();
  await desktop.getByRole("button", { name: "Source" }).click();
  await desktop.getByRole("region", { name: "README.md contents" }).waitFor();
  await desktop.getByRole("button", { name: "Preview" }).click();
  await desktop.screenshot({ path: `${evidence}/desktop-dark-markdown.png` });
  await desktop.getByRole("link", { name: "Release notes" }).click();
  await desktop.getByRole("heading", { name: "Release plan" }).waitFor();
  const crumbs = desktop.getByRole("navigation", { name: "Breadcrumb" });
  assert.deepEqual((await crumbs.locator("li").allTextContents()).map((text) => text.trim()), ["Workspace", "notes", "release.md"]);
  assert.equal(await item(desktop, "release.md").getAttribute("aria-selected"), "true", "opening a file reveals it in the tree");

  // Image and binary views.
  await item(desktop, "assets").click();
  await item(desktop, "mark.png").click();
  await desktop.waitForFunction(() => document.querySelector(".wb-files-image img")?.naturalWidth === 24);
  await desktop.getByText(/24 × 24 px/).waitFor();
  await desktop.screenshot({ path: `${evidence}/desktop-dark-image.png` });
  await item(desktop, "archive.zip").click();
  await desktop.getByText("Binary file, 48 KB").waitFor();

  // Quick open: the shortcut inside the pane, arrows, Enter.
  await item(desktop, "archive.zip").focus();
  await desktop.keyboard.press("ControlOrMeta+p");
  const quick = desktop.getByRole("dialog", { name: "Go to file" });
  await quick.waitFor();
  await desktop.keyboard.type("deploy");
  await quick.getByRole("option", { name: /deploy\.sh/ }).waitFor();
  await desktop.screenshot({ path: `${evidence}/desktop-dark-quick-open.png` });
  await desktop.keyboard.press("Enter");
  assert.equal(await quick.count(), 0);
  const script = desktop.getByRole("region", { name: "deploy.sh contents" });
  await script.waitFor();
  assert.ok((await script.locator(".wb-files-gutter").textContent()).endsWith("\n122"), "every line is numbered");
  assert.ok(requests.some((path) => path.startsWith("/api/workbench/search?q=deploy")));
  await desktop.keyboard.press("ControlOrMeta+p");
  await quick.waitFor();
  await desktop.keyboard.press("Escape");
  assert.equal(await quick.count(), 0, "Escape closes quick open");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "deploy.sh", "focus returns to the tree");
  await desktop.getByRole("button", { name: "Go to file" }).click();
  await quick.waitFor();
  await desktop.locator(".wb-files-viewer").click({ position: { x: 300, y: 400 } });
  assert.equal(await quick.count(), 0, "a click outside closes quick open");
  assert.equal(await desktop.getByRole("region", { name: "Workbench" }).count(), 1, "Escape does not close the workbench");
  assert.equal(await desktop.getByRole("tab", { name: "deploy.sh" }).count(), 1, "the tab is titled after the open file");
  await desktop.screenshot({ path: `${evidence}/desktop-dark-code.png` });

  // The tab remembers its file across a reload.
  await desktop.reload();
  await desktop.getByRole("region", { name: "deploy.sh contents" }).waitFor();
  await item(desktop, "deploy.sh").waitFor();
  assert.equal(await item(desktop, "deploy.sh").getAttribute("aria-selected"), "true", "reload reopens and reveals the file");

  const light = await open({ width: 1440, height: 900 }, "light");
  await openFiles(light);
  await item(light, "README.md").click();
  await light.getByRole("heading", { name: "Fixture workspace" }).waitFor();
  await light.waitForFunction(() => document.querySelector(".wb-files-md img[alt='Mark']")?.naturalWidth === 24);
  await light.screenshot({ path: `${evidence}/desktop-light-markdown.png` });

  for (const theme of ["dark", "light"]) {
    const mobile = await open({ width: 390, height: 844 }, theme);
    await openFiles(mobile);
    const tree = await mobile.getByRole("tree").boundingBox();
    assert.ok(tree.width > 360, "the tree spans the phone width");
    await item(mobile, "scripts").click();
    await item(mobile, "deploy.sh").click();
    const viewer = await mobile.getByRole("region", { name: "deploy.sh contents" }).boundingBox();
    assert.ok(viewer.y > tree.y + 100 && viewer.width > 360, "the viewer stacks under the tree");
    assert.equal(await noOverflow(mobile), true, `no horizontal overflow at 390px (${theme})`);
    const row = await item(mobile, "deploy.sh").boundingBox();
    assert.ok(row.height >= 40, "touch-sized rows");
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}-code.png` });
    await item(mobile, "README.md").click();
    await mobile.getByRole("heading", { name: "Fixture workspace" }).waitFor();
    assert.equal(await noOverflow(mobile), true, "Markdown with a table does not overflow");
    await mobile.screenshot({ path: `${evidence}/mobile-${theme}-markdown.png` });
  }

  assert.deepEqual(external, [], "no request leaves for remote Markdown images");
  assert.deepEqual(errors, []);
  console.log(
    "PASS workbench files: tree with folders first, dotfiles and blocked links, keyboard tree, Markdown with workspace links and images, remote images blocked, source view, line numbers, image, binary, quick open, breadcrumbs, reload reopens, light and dark, stacked mobile without overflow",
  );
} finally {
  await browser.close();
}
