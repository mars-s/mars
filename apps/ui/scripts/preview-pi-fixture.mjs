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
                { type: "toolCall", id: "t1", name: "exec_command", arguments: { command: "npm run test:install" } },
                { type: "toolCall", id: "t2", name: "read_file", arguments: { path: "scripts/deploy-host.mjs" } },
              ],
            },
            { role: "toolResult", toolCallId: "t1", content: text("not ok 3 - missing workspace lock marker"), isError: true, details: { exitCode: 1 } },
            { role: "toolResult", toolCallId: "t2", content: text("// 212 lines read") },
            {
              role: "assistant",
              content: text(
                "Found it. A fresh clone has no **workspace lock marker**, so the script skips the dependency install.\n\n" +
                  "| Step | Before | After |\n| --- | --- | --- |\n| Lock check | Trusts checkout lock | Requires installed marker |\n| Install | Skipped | Runs filtered install |\n\n" +
                  "```js\nif (!existsSync(marker)) await installWorkspace({ filter: \"@mars/pi-host\" });\n```\n\n" +
                  "Want me to apply the fix and rerun the check?",
              ),
            },
          ],
        },
      ],
    },
  ],
  ["2", { title: "New conversation", running: false, entries: [] }],
  ["3", { title: "Weekly reading list", running: false, entries: [] }],
]);

function state(id) {
  const conversation = conversations.get(id) ?? conversations.get("1");
  return {
    runtime: "Pi Durable 1.3.0 (preview fixture)",
    providerReady: true,
    conversationId: id,
    selectedConversationId: id,
    conversationTitle: conversation.title,
    conversations: [...conversations].map(([key, row]) => ({ id: key, title: row.title, running: row.running })),
    subthreads: [],
    workflows: [],
    workers: [],
    usage: {},
    auth: { connected: true, state: "connected", events: [] },
    anthropicAuth: { connected: false, state: "idle", events: [] },
    models: [
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
    ],
    extensions: [],
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
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const body = req.method === "POST" ? await readBody(req) : {};
  const id = url.searchParams.get("conversationId") || String(body.conversationId || "1");
  if (url.pathname === "/api/state") return json(res, 200, state(id));
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
