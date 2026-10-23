// Settings, Connectors in the browser, against routed fixtures (docs/CONNECTORS.md
// "Settings"): the list with kind, status, tool count and last error, built-in rows, adding
// an HTTP API connector with a key (posted once, never shown again), Connect opening the
// OAuth sign-in in a new tab, Remove with a confirmation, and no overflow at 390px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/connectors-ui";
await mkdir(evidence, { recursive: true });
const KEY = "weather-key-" + "x".repeat(20);
const SIGN_IN = "https://auth.example/authorize?client_id=mars&state=abc";
const state = () => ({
  runtime: "Pi Durable 1.3.0",
  conversationId: 1,
  auth: { connected: true, state: "connected", events: [] },
  providerReady: true,
  models: [{ id: "gpt-6-luna", name: "Luna", provider: "openai", efforts: ["low", "medium", "high"] }],
  extensions: [],
  conversations: [{ id: 1, title: "Main" }],
  view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
});
const fixture = () => ({
  connectors: [
    { id: "linear", name: "Linear", kind: "mcp", transport: "http", url: "https://mcp.linear.app/mcp", auth: { type: "oauth" }, status: "needs_auth", lastError: "The sign-in expired and could not be renewed; press Connect to sign in again", toolCount: 0, tools: [], hasKey: false, signedIn: true },
    { id: "local-files", name: "Local files", kind: "mcp", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/owner/a-very-long-folder-name/that-keeps-going/and-going"], auth: { type: "none" }, status: "connected", lastError: "", toolCount: 3, tools: ["conn_local_files_read"], hasKey: false, signedIn: false },
  ],
  builtIn: [
    { id: "discord", name: "Discord", kind: "built-in", status: "not_set_up", detail: "Set up in Settings, Apps" },
    { id: "opencode", name: "OpenCode Go", kind: "built-in", status: "connected", detail: "Key saved; its models are in the model menu" },
    { id: "github", name: "GitHub through Composio", kind: "built-in", status: "available", detail: "github_push uses the Composio CLI on this machine" },
  ],
  redirectUri: "http://127.0.0.1:3081/api/connectors/oauth/callback",
});

const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
try {
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(name + ": " + error.message));
    let data = fixture();
    const posts = [];
    await context.route("https://auth.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Sign in</title><p>Fake sign-in</p>" }));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/state") return route.fulfill({ json: state() });
      if (url.pathname === "/api/connectors" && request.method() === "GET") return route.fulfill({ json: data });
      if (request.method() !== "POST") return route.fulfill({ json: { conversations: [{ id: 1, title: "Main" }], rootId: 1 } });
      const body = request.postDataJSON();
      posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/connectors") {
        const row = { id: "weather", name: body.name, kind: body.kind, transport: "http", url: body.url, auth: { type: body.auth.type, header: body.auth.header }, status: "not_connected", lastError: "", toolCount: 0, tools: [], hasKey: !!body.key, signedIn: false };
        data = { ...data, connectors: [...data.connectors, row] };
        return route.fulfill({ status: 201, json: { connector: row } });
      }
      const match = /^\/api\/connectors\/([a-z0-9-]+)\/(connect|refresh|remove)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (action === "remove") {
          data = { ...data, connectors: data.connectors.filter((row) => row.id !== id) };
          return route.fulfill({ json: { removed: true, id, name: id } });
        }
        const row = data.connectors.find((item) => item.id === id);
        if (row.auth.type === "oauth") return route.fulfill({ json: { connector: row, authorizationUrl: SIGN_IN } });
        Object.assign(row, { status: "connected" });
        return route.fulfill({ json: { connector: row } });
      }
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
    await waitForHydration(page);
    await page.getByRole("button", { name: "Open settings" }).first().click();
    await page.getByRole("tab", { name: "Connectors", exact: true }).click();
    const panel = page.locator(".connector-settings");
    await panel.getByText("Your connectors").waitFor();
    for (const text of ["Linear", "Needs sign-in", "press Connect to sign in again", "Local files", "Local MCP command, 3 tools", "Discord", "OpenCode Go", "GitHub through Composio", "Not set up"])
      assert.ok(await panel.getByText(text, { exact: false }).first().isVisible(), name + ": shows " + text);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".connector-settings *")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && !["SPAN", "STRONG", "BUTTON", "CODE", "A", "OPTION", "SELECT"].includes(el.tagName)));
    assert.equal(overflow, false, name + ": nothing overflows");
    await page.screenshot({ path: evidence + "/" + name + "-list.png" });

    if (name === "desktop") {
      // Add an HTTP API with a key; the form posts it once and clears it.
      await panel.getByLabel("Name").fill("Weather");
      await panel.getByLabel("Type").selectOption("http");
      await panel.getByLabel("Base URL").fill("https://api.weather.example/v1");
      await panel.getByLabel("Sign-in").selectOption("key");
      await panel.getByLabel("Key", { exact: true }).fill(KEY);
      await panel.getByLabel("Header name").fill("X-Api-Key");
      await panel.getByRole("button", { name: "Add connector" }).click();
      await panel.getByText("Weather is connected.").waitFor();
      assert.deepEqual(posts.find((post) => post.path === "/api/connectors").body, { name: "Weather", kind: "http", url: "https://api.weather.example/v1", auth: { type: "key", header: "X-Api-Key" }, key: KEY });
      assert.deepEqual(posts.at(-1), { path: "/api/connectors/weather/connect", body: {} });
      await panel.getByText("HTTP API, key saved").waitFor();
      assert.ok(!(await page.content()).includes(KEY), "the key is not left in the page");

      // Connect on an OAuth connector opens its sign-in in a new tab and shows the link.
      const opened = context.waitForEvent("page");
      await panel.locator(".connector-row", { hasText: "Linear" }).getByRole("button", { name: "Reconnect" }).click();
      const tab = await opened;
      await tab.waitForURL(/auth\.example/);
      assert.equal(tab.url(), SIGN_IN);
      await tab.close();
      const link = panel.getByRole("link", { name: "Open the Linear sign-in" });
      await link.waitFor();
      assert.equal(await link.getAttribute("href"), SIGN_IN);
      assert.equal(await link.getAttribute("target"), "_blank");
      await page.screenshot({ path: evidence + "/" + name + "-signing-in.png" });

      // Remove asks once more, then posts.
      await panel.getByRole("button", { name: "Remove Local files" }).click();
      await panel.getByRole("button", { name: "Remove Local files" }).click();
      await panel.getByText("Local files removed, with its tools and saved credentials.").waitFor();
      assert.deepEqual(posts.at(-1), { path: "/api/connectors/local-files/remove", body: {} });
      assert.equal(await panel.locator(".connector-row", { hasText: "Local MCP command" }).count(), 0);
    }
    await context.close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS connectors UI: list with kind, status, tool count and last error; built-in rows; Add connector posts an HTTP API key once and clears it; Connect opens the OAuth sign-in in a new tab with a fallback link; Remove confirms then posts; no overflow at 390px");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
