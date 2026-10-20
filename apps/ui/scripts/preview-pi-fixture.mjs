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
    "7",
    {
      title: "Draft the release notes",
      running: true,
      entries: [
        {
          id: 71,
          model: [
            { role: "user", content: text("Draft release notes from the last ten commits.") },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "r1", name: "bash", arguments: { command: "git log --oneline -10" } },
              ],
            },
            { role: "toolResult", toolCallId: "r1", content: text("1d492c0 Record the redesign integration results\nbb3b03d Adopt the Phase mark"), details: { exitCode: 0 } },
          ],
        },
      ],
      live: {
        run: { id: 1 },
        generation: { message: { content: text("Grouping the commits by area") } },
        nestedTools: [
          { callId: "r2", name: "read", arguments: { path: ".agents/CHANGELOG.md" }, status: "running", summary: {} },
        ],
      },
    },
  ],
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
      { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
      { id: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
    ],
    thinkingLevel: conversation.thinkingLevel ?? "medium",
    extensions: [],
    ...(conversation.child ? { parentConversationId: "1" } : {}),
    view: {
      entries: conversation.entries,
      docs: {
        "pi.agent": {
          model: conversation.model?.startsWith("anthropic/")
            ? { provider: "anthropic", modelId: conversation.model.slice("anthropic/".length) }
            : { provider: "openai", modelId: conversation.model || "gpt-6-sol" },
        },
        ...(conversation.live ? { "pi.live": conversation.live } : {}),
      },
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
  // Workbench fixture routes: labelled data only, mirroring docs/WORKBENCH.md.
  if (url.pathname === "/api/workbench/capabilities")
    return json(res, 200, {
      tools: {
        changes: { available: false, reason: "Fixture: Changes is not built yet." },
        files: { available: false, reason: "Fixture: Files is not built yet." },
        terminal: { available: true },
        "side-chat": { available: true },
        page: { available: false, reason: "Fixture: Pages are not built yet." },
        browser: { available: false, reason: "Fixture: Browser is not built yet." },
      },
    });
  if (url.pathname === "/api/workbench/suggestions")
    return json(res, 200, {
      suggestions: [
        { kind: "service", title: "Fixture service (Chemwatch dev)", port: 3100 },
        { kind: "page", title: "Release plan (fixture)", name: "release-plan" },
      ],
    });
  // workbench lane: terminal
  // A fixture shell: it echoes input and answers a few words. Nothing runs on this machine.
  {
    const terminal = (globalThis.marsFixtureTerminals ??= new Map());
    const append = (session, text) => {
      session.output = Buffer.concat([session.output, Buffer.from(text)]);
      for (const wake of session.waiters.splice(0)) wake();
    };
    const prompt = "\x1b[2mfixture\x1b[0m:workspace $ ";
    if (url.pathname === "/api/workbench/terminals")
      return json(res, 200, { sessions: [...terminal.entries()].map(([id, s]) => ({ id, created: s.created, lastActive: s.created, exited: s.exited })) });
    if (url.pathname === "/api/workbench/terminal" && req.method === "POST") {
      const id = [...Array(24)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
      const session = { created: Date.now(), output: Buffer.alloc(0), line: "", waiters: [], exited: false, exitCode: undefined };
      terminal.set(id, session);
      append(session, `Fixture terminal: a stand-in for the Pi host shell. Try "help".\r\n${prompt}`);
      return json(res, 201, { id });
    }
    const match = /^\/api\/workbench\/terminal\/([a-f0-9]{24})(?:\/(input|resize|kill))?$/.exec(url.pathname);
    if (match) {
      const session = terminal.get(match[1]);
      if (!session) return json(res, 404, { error: "Terminal session not found" });
      const reply = (since) => ({
        offset: session.output.length,
        data: session.output.subarray(Math.min(since, session.output.length)).toString("base64"),
        ...(session.exited ? { exited: true, exitCode: session.exitCode } : {}),
      });
      if (!match[2]) {
        const since = Number(url.searchParams.get("since") || 0);
        if (session.output.length > since || session.exited) return json(res, 200, reply(since));
        return new Promise((resolve) => {
          const done = () => (clearTimeout(timer), resolve(json(res, 200, reply(since))));
          const timer = setTimeout(done, 20000);
          session.waiters.push(done);
        });
      }
      if (match[2] === "kill") {
        session.exited = true;
        session.exitCode = 129;
        append(session, "");
        return json(res, 200, { id: match[1], exited: true, exitCode: 129 });
      }
      if (session.exited) return json(res, 409, { error: "This terminal session has ended" });
      if (match[2] === "resize") {
        session.size = `${body.rows} ${body.cols}`;
        return json(res, 200, { cols: body.cols, rows: body.rows });
      }
      for (const char of Buffer.from(String(body.data || ""), "base64").toString()) {
        if (char === "\r") {
          const command = session.line.trim();
          session.line = "";
          const answers = {
            help: "Fixture commands: help, stty size, date, exit",
            "stty size": session.size || "24 80",
            date: "Wed 21 Oct 2026 09:00:00 AEDT (fixture)",
          };
          if (command === "exit") {
            append(session, "\r\nlogout\r\n");
            session.exited = true;
            session.exitCode = 0;
            append(session, "");
          } else
            append(session, `\r\n${command ? (answers[command] ?? `fixture: ${command}: not a real shell`) + "\r\n" : ""}${prompt}`);
        } else if (char === "\x7f") {
          if (session.line) (session.line = session.line.slice(0, -1)), append(session, "\b \b");
        } else if (char >= " ") (session.line += char), append(session, char);
      }
      return json(res, 200, { accepted: 1 });
    }
  }
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
  if (url.pathname === "/api/model") {
    const conversation = conversations.get(id);
    if (conversation) conversation.model = String(body.model);
    return json(res, 200, { model: body.model });
  }
  if (url.pathname === "/api/effort") {
    const conversation = conversations.get(id);
    if (conversation) conversation.thinkingLevel = String(body.effort);
    return json(res, 200, { effort: body.effort });
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
