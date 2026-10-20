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
        files: { available: true },
        terminal: { available: false, reason: "Fixture: Terminal is not built yet." },
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
  // workbench lane: files
  {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAhklEQVR42u2ZuRGAMBDE3CWlUCvVQAcE53u8O9IMuRRhr9cCALDiua/375OUPjYmKj4ekiU+ElIl3xJRLV8a0SVfEtEtnx4hHTAlnxYhHTAtvx1BwGTAKfLhCAIIIIAAAmz+BRwlOJFyH+BOLB4gP6tYDFsW06LFuGsxr9s8cNg8MQEAhPkAQyuN/whBKW0AAAAASUVORK5CYII=",
      "base64",
    );
    const files = {
      "README.md": "# Fixture workspace\n\nThis tree is **fixture data** from the preview host, not a real Pi workspace.\n\n- [Release notes](notes/release.md)\n- [Deploy script](scripts/deploy.sh)\n\n| Item | State |\n| --- | --- |\n| Files pane | Fixture |\n\n![Fixture mark](assets/mark.png)\n",
      "notes/release.md": "# Release plan (fixture)\n\n1. Merge the workbench lanes.\n2. Run the gate.\n\n> Fixture text only.\n",
      "notes/ideas.txt": "Fixture idea list\n- tree keyboard\n- quick open\n",
      "scripts/deploy.sh": "#!/usr/bin/env bash\n# Fixture deploy script\nset -euo pipefail\ncd \"$(dirname \"$0\")/..\"\nnpm ci\nnpm run build\necho \"fixture deploy done\"\n",
      "src/index.ts": "// Fixture source file\nexport function greet(name: string) {\n  return `Hello, ${name}`;\n}\n",
      ".env.example": "# Fixture\nMARS_PI_TOKEN=\n",
    };
    const binaries = { "assets/mark.png": PNG, "assets/archive.zip": Buffer.alloc(48 * 1024) };
    const dirs = ["", "assets", "notes", "scripts", "src", "node_modules"];
    const now = Date.parse("2026-10-20T09:30:00+11:00");
    const children = (dir) => {
      const prefix = dir ? `${dir}/` : "";
      const names = new Map();
      for (const path of [...dirs.filter(Boolean), ...Object.keys(files), ...Object.keys(binaries)]) {
        if (!path.startsWith(prefix) || path === dir) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        if (!names.has(name)) names.set(name, rest.length || dirs.includes(prefix + name) ? "dir" : "file");
      }
      return [...names].map(([name, type]) => {
        const path = prefix + name;
        const size = type === "dir" ? 0 : (files[path]?.length ?? binaries[path].length);
        return { name, type, size, modified: now, hidden: name.startsWith(".") };
      }).sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
    };
    const rel = url.searchParams.get("path") || "";
    if (url.pathname === "/api/workbench/files") {
      if (!dirs.includes(rel)) return json(res, 404, { error: "Fixture: that folder does not exist." });
      return json(res, 200, { path: rel, entries: children(rel), truncated: false });
    }
    if (url.pathname === "/api/workbench/file") {
      if (rel in files) return json(res, 200, { path: rel, size: files[rel].length, modified: now, kind: "text", text: files[rel], truncated: false });
      if (rel === "assets/mark.png") return json(res, 200, { path: rel, size: PNG.length, modified: now, kind: "image", mime: "image/png" });
      if (rel in binaries) return json(res, 200, { path: rel, size: binaries[rel].length, modified: now, kind: "binary" });
      return json(res, 404, { error: "Fixture: that file does not exist." });
    }
    if (url.pathname === "/api/workbench/raw") {
      if (rel !== "assets/mark.png") return json(res, 415, { error: "Fixture: only images can be shown directly." });
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      return res.end(PNG);
    }
    if (url.pathname === "/api/workbench/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      const all = [...Object.keys(files), ...Object.keys(binaries)];
      const results = q ? all.filter((path) => path.split("/").pop().toLowerCase().includes(q)).map((path) => ({ path, type: "file" })) : [];
      return json(res, 200, { query: q, results, truncated: false, timedOut: false });
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
