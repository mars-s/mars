import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL } from "./browser-options.mjs";
const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/plugins-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let uiLoads = 0;
let failChange = false;
const hash = "b".repeat(64);
const plugins = [
  {
    name: "fixture-canvas",
    title: "Canvas notes",
    description: "Installed fixture capability",
    version: "1.2.0",
    kind: "extension",
    enabled: true,
    uiEnabled: true,
    hasUi: true,
    tools: [{ name: "canvas_note", description: "Create a local note", enabled: true }],
  },
  {
    name: "vm-control",
    title: "VM control",
    description: "Native host capabilities",
    kind: "system",
    enabled: true,
    uiEnabled: false,
    hasUi: false,
    tools: [{ name: "host_exec", description: "Run a command", enabled: true }],
  },
];
await page.route(`**/extensions/${hash}/client.js`, (route) => {
  uiLoads++;
  return route.fulfill({
    contentType: "text/javascript",
    body: 'export function mount(root){root.textContent="Canvas interface mounted";return()=>{root.textContent=""}}',
  });
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/plugins") {
    if (request.method() === "GET") return route.fulfill({ json: { plugins } });
    if (failChange) {
      failChange = false;
      return route.fulfill({ status: 500, json: { error: "Could not save fixture setting" } });
    }
    const body = request.postDataJSON();
    const plugin = plugins.find((item) => item.name === body.name);
    for (const key of ["enabled", "uiEnabled"])
      if (typeof body[key] === "boolean") plugin[key] = body[key];
    for (const [name, enabled] of Object.entries(body.tools || {}))
      plugin.tools.find((tool) => tool.name === name).enabled = enabled;
    return route.fulfill({ json: { plugin } });
  }
  return route.fulfill({
    json: {
      runtime: "Pi Durable",
      conversationId: "1",
      auth: { connected: true },
      providerReady: true,
      conversations: [{ id: "1", title: "Activity fixture" }],
      extensions: [{ name: "fixture-canvas", title: "Canvas notes", hash }],
      view: {
        docs: { "pi.agent": { model: { modelId: "Luna" } }, "pi.live": {} },
        entries: [
          {
            id: 1,
            model: [
              { role: "assistant", content: [{ type: "text", text: "I will inspect the file." }] },
            ],
          },
          {
            id: 2,
            model: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "code",
                    name: "codemode",
                    arguments: { code: "await tools.host_read({path:'note.txt'})" },
                  },
                ],
              },
            ],
          },
          {
            id: 3,
            model: [
              {
                role: "toolResult",
                toolCallId: "code",
                content: "Finished",
                details: {
                  calls: [
                    {
                      id: 1,
                      name: "host_read",
                      args: '{"path":"note.txt"}',
                      status: "ok",
                      durationMs: 10,
                    },
                    {
                      id: 2,
                      name: "host_exec",
                      args: '{"command":"false"}',
                      status: "error",
                      error: "Command failed",
                    },
                  ],
                },
              },
            ],
          },
          {
            id: 4,
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "The command failed. The file was read." }],
              },
            ],
          },
        ],
      },
    },
  });
});
try {
  await page.goto(
    uiBaseURL(),
  );
  await page.getByText("2 actions", { exact: true }).waitFor();
  assert.equal(await page.getByText("Read file", { exact: true }).isVisible(), false);
  await page.getByText("2 actions", { exact: true }).click();
  await page.getByText("Read file", { exact: true }).waitFor();
  await page.getByText("Run command", { exact: true }).click();
  await page.getByText("Command failed", { exact: true }).waitFor();
  assert.equal(uiLoads, 0);
  await page
    .locator(".live-sidebar")
    .getByRole("button", { name: /^Extensions/ })
    .click();
  await page.getByRole("heading", { name: "Canvas notes", exact: true }).waitFor();
  assert.equal(uiLoads, 0);
  assert.equal(
    await page.getByRole("heading", { name: "VM control", exact: true }).isVisible(),
    false,
  );
  await page.getByRole("button", { name: "Open interface", exact: true }).click();
  await page.getByText("Canvas interface mounted", { exact: true }).waitFor();
  assert.equal(uiLoads, 1);
  await page.getByText("Manage Canvas notes", { exact: true }).click();
  await page.getByRole("switch", { name: "Enable canvas_note", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Enable canvas_note"]')
        ?.getAttribute("aria-checked") === "false",
  );
  failChange = true;
  await page.getByRole("switch", { name: "Enable canvas_note", exact: true }).click();
  await page.getByText("Could not save fixture setting", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("switch", { name: "Enable canvas_note", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  await page.getByRole("switch", { name: "Enable Canvas notes", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Enable Canvas notes"]')
        ?.getAttribute("aria-checked") === "false",
  );
  assert.equal(await page.getByText("Canvas interface mounted", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Open interface", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${evidence}/plugins-fixture-pass.png`, fullPage: true });
  console.log(
    "PASS grouped native activity, dynamic catalogue, explicit interface mount, native toggles and failed setting retention",
  );
} catch (error) {
  await page.screenshot({
    path: `${evidence}/plugins-fixture-failure.png`,
    fullPage: true,
  });
  console.error(
    JSON.stringify({
      uiLoads,
      errors,
      body: (await page.locator("body").innerText()).slice(-5000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
