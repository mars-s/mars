// Development-only fake Pi host for visual previews. Every reply is fixture text.
// Usage: node scripts/preview-pi-fixture.mjs  (listens on MARS_FIXTURE_PORT, default 3191)
import { createServer } from "node:http";

const port = Number(process.env.MARS_FIXTURE_PORT || 3191);
const text = (value) => [{ type: "text", text: value }];
const conversations = new Map([
  [
    "1",
    {
      title: "Tidy the Pi host deploy script",
      running: false,
      entries: [
        {
          id: 1,
          model: [
            { role: "user", content: text("Can you check why the deploy script fails on a fresh clone?") },
            {
              role: "assistant",
              content: [
                ...text("I'll run the install check first, then read the script."),
                { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm run test:install" } },
                { type: "toolCall", id: "t2", name: "read", arguments: { path: "scripts/deploy-host.mjs" } },
                { type: "toolCall", id: "t3", name: "web_search", arguments: { query: "npm workspaces filtered install marker" } },
              ],
              usage: { input: 18400, output: 620, cacheRead: 0, cacheWrite: 0, totalTokens: 19020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            },
            { role: "toolResult", toolCallId: "t1", content: text("ok 1 - bootstrap\nok 2 - service units\nnot ok 3 - missing workspace lock marker"), isError: true, details: { exitCode: 1, truncated: false } },
            { role: "toolResult", toolCallId: "t2", content: text("// 212 lines read") },
            { role: "toolResult", toolCallId: "t3", content: text("1. npm docs: workspaces\n2. Stack Overflow: npm ci --workspace") },
            {
              role: "assistant",
              content: [
                ...text("Found it. Patching the lock check now."),
                {
                  type: "toolCall",
                  id: "t4",
                  name: "edit",
                  arguments: { path: "scripts/deploy-host.mjs", edits: [{ oldText: "if (existsSync(checkoutLock)) return;", newText: "if (!existsSync(marker)) await installWorkspace();" }] },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "t4",
              content: text("Successfully replaced 1 block(s) in scripts/deploy-host.mjs."),
              details: {
                patch: "--- scripts/deploy-host.mjs\n+++ scripts/deploy-host.mjs\n@@ -41,2 +41,4 @@\n const marker = lockMarker(stage);\n-if (existsSync(checkoutLock)) return;\n+if (!existsSync(marker)) {\n+  await installWorkspace({ filter: \"@mars/pi-host\" });\n+}\n",
              },
            },
            {
              role: "assistant",
              content: text(
                "Fixed. A fresh clone has no **workspace lock marker**, so the script skipped the dependency install.\n\n" +
                  "| Step | Before | After |\n| --- | --- | --- |\n| Lock check | Trusts checkout lock | Requires installed marker |\n| Install | Skipped | Runs filtered install |\n\n" +
                  "```js\nif (!existsSync(marker)) await installWorkspace({ filter: \"@mars/pi-host\" });\n```\n\n" +
                  "Want me to rerun the install check?",
              ),
            },
          ],
        },
      ],
    },
  ],
  ["2", { title: "New conversation", running: false, entries: [] }],
  ["3", { title: "Weekly reading list", running: false, entries: [] }],
  [
    "4",
    {
      title: "Audit service units",
      running: true,
      child: true,
      entries: [{ id: 41, model: [{ role: "user", content: text("Check the systemd unit generator for path bugs") }] }],
    },
  ],
]);

function state(id) {
  const conversation = conversations.get(id) ?? conversations.get("1");
  return {
    runtime: "Pi Durable 1.3.0 (preview fixture)",
    providerReady: true,
    conversationId: id,
    selectedConversationId: id,
    conversationTitle: conversation.title,
    conversations: [...conversations].filter(([, row]) => !row.child).map(([key, row]) => ({ id: key, title: row.title, running: row.running })),
    subthreads: id === "1" ? [{ id: "4", conversationId: "1", title: "Audit service units", status: "running", modelId: "gpt-6-sol", provider: "openai" }] : [],
    workflows:
      id === "1"
        ? [{ id: "w1", conversationId: "1", title: "Release check", status: "running", currentStep: 1, steps: [
            { index: 0, title: "Run tests", status: "completed", conversationId: "5", provider: "openai", modelId: "gpt-6-luna", durationMs: 41000, usage: {} },
            { index: 1, title: "Build", status: "running", conversationId: "6", provider: "openai", modelId: "gpt-6-luna", usage: {} },
          ] }]
        : [],
    workers: id === "1" ? [{ id: "4", conversationId: "1", modelId: "gpt-6-sol", provider: "openai", status: "running", title: "Audit service units", task: "Check the systemd unit generator for path bugs" }] : [],
    usage: { models: { "openai/gpt-6-sol": { input: 18400, output: 620, totalTokens: 19020 } }, tools: {} },
    context:
      id === "1"
        ? { basis: "reported", limit: 400000, used: 21480, compactAt: 0.959, autoCompact: true, segments: [
            { id: "instructions", label: "Instructions", tokens: 7200 },
            { id: "tools", label: "Tool results", tokens: 9100 },
            { id: "messages", label: "Messages", tokens: 5180 },
          ] }
        : { basis: "estimated", limit: 400000, used: 7200, compactAt: 0.959, autoCompact: true, segments: [{ id: "instructions", label: "Instructions", tokens: 7200 }] },
    auth: { connected: true, state: "connected", events: [] },
    anthropicAuth: { connected: false, state: "idle", events: [] },
    models: [
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "gpt-6-luna", name: "GPT-6 Luna" },
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
    ],
    extensions: [],
    ...(conversation.child ? { parentConversationId: "1" } : {}),
    view: {
      entries: conversation.entries,
      docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-sol" } } },
    },
  };
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const body = req.method === "POST" ? await readBody(req) : {};
  const id = url.searchParams.get("conversationId") || String(body.conversationId || "1");
  if (url.pathname === "/api/state") return json(res, 200, state(id));
  if (url.pathname === "/api/attachments" && req.method === "POST")
    return json(res, 201, {
      attachment: {
        id: "a".repeat(64),
        name: decodeURIComponent(String(req.headers["x-file-name"] || "image")),
        mimeType: String(req.headers["content-type"] || "image/png"),
        size: 1,
        width: 1,
        height: 1,
        url: `/api/attachments/${"a".repeat(64)}`,
      },
    });
  if (url.pathname === "/api/plugins") return json(res, 200, { plugins: [] });
  if (url.pathname === "/api/connections")
    return json(res, 200, {
      discord: { configured: false, connected: false, guildId: null },
      opencode: { configured: false, enabled: false },
    });
  if (url.pathname === "/api/conversations" && req.method === "POST") {
    const next = String(conversations.size + 1);
    conversations.set(next, { title: "New conversation", running: false, entries: [] });
    return json(res, 201, { conversation: { id: next, title: "New conversation" } });
  }
  if (url.pathname === "/api/chat") {
    const conversation = conversations.get(id);
    conversation?.entries.push({
      id: Date.now(),
      model: [
        { role: "user", content: text(body.text || "") },
        { role: "assistant", content: text("Preview fixture: no model is connected, so this reply is canned.") },
      ],
    });
    return json(res, 202, { submissionId: Date.now() });
  }
  return json(res, 200, { accepted: true });
}).listen(port, "127.0.0.1", () => console.log(`Preview Pi fixture on http://127.0.0.1:${port}`));
