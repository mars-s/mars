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
  ["3", { title: "Weekly reading list", running: false, channel: "telegram", entries: [{ id: 31, model: [{ role: "user", content: text("Add the Hindsight paper to my reading list") }, { role: "assistant", content: text("Added. It is third on this week's list.") }] }] }],
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
  [
    "8",
    {
      title: "Name the release (side chat)",
      running: false,
      sideOf: "1",
      entries: [
        { id: 81, model: [{ role: "user", content: text("Three names for the workbench release?") }] },
        { id: 82, model: [{ role: "assistant", content: [{ type: "text", text: "**Split Pane**, **Side Table** or **Second Desk**. (Fixture reply.)" }] }] },
      ],
    },
  ],
]);

const gatewayStart = Date.parse("2026-10-22T09:00:00Z");
const freshGateway = () => ({
  adapters: [
    { channel: "api", state: "running", detail: "", failures: 0 },
    { channel: "telegram", state: "running", detail: "@mars_fixture_bot", failures: 0 },
    { channel: "discord", state: "failed", detail: "Discord closed the connection (4014): enable the Message Content intent in the Developer Portal", failures: 3 },
  ],
  bindings: [{ route: "telegram:999:dm:5550001", channel: "telegram", conversationId: "3", title: "Weekly reading list" }],
  pairings: [{ code: "K7QX2M9P", channel: "telegram", sender: "5550002", name: "sam_k", expiresAt: new Date(gatewayStart + 3600000).toISOString() }],
  allowed: { telegram: ["5550001"], api: ["owner"] },
  outbox: 0,
  audit: [
    { at: new Date(gatewayStart + 300000).toISOString(), channel: "telegram", decision: "denied" },
    { at: new Date(gatewayStart + 240000).toISOString(), channel: "telegram", decision: "accepted", conversationId: "3" },
    { at: new Date(gatewayStart + 120000).toISOString(), channel: "telegram", decision: "duplicate" },
    { at: new Date(gatewayStart + 60000).toISOString(), channel: "discord", decision: "adapter_failed" },
  ],
});
let gateway = freshGateway();

// Updates (docs/UPDATES.md): two fixture commits ready on main. Update now steps through the
// real step names on a timer, then reports updated. Labelled fixture data only.
const UPDATE_STEPS = ["check", "merge", "tree", "dependencies", "syntax", "build", "runtime", "boot", "checks", "stop", "checkout", "swap_dependencies", "swap_ui", "swap_runtime", "start", "health"];
const freshUpdates = () => ({
  head: "c1787bd53fc8",
  auto: false,
  startedAt: 0,
  status: {
    state: "fast_forward", checkedAt: new Date(Date.now() - 4 * 60000).toISOString(), remote: "origin", branch: "main",
    head: "c1787bd53fc8", target: "9a41e02b7c10", behind: 2, ahead: 0,
    commits: ["9a41e02 Fixture: tidy the composer toolbar", "5d0c7a1 Fixture: faster gateway reconnect"],
    blockers: [], reconciled: false, next: "2 new commits on main. Update when ready.",
  },
  last: null,
});
let updates = freshUpdates();
function updateView() {
  if (updates.startedAt) {
    const done = Math.floor((Date.now() - updates.startedAt) / 350);
    if (done >= UPDATE_STEPS.length) {
      updates.last = { id: "fixture", outcome: "updated", detail: "Now on 9a41e02b7c10.", from: "c1787bd53fc8", result: "9a41e02b7c10", restarted: true, next: "Updated and healthy. Nothing else to do.", steps: UPDATE_STEPS.map((name) => ({ name, status: name === "checks" ? "skipped" : "done" })) };
      updates.head = "9a41e02b7c10";
      updates.status = { ...updates.status, state: "up_to_date", head: "9a41e02b7c10", behind: 0, commits: [], checkedAt: new Date().toISOString(), next: "Mars is up to date. Nothing to do." };
      updates.startedAt = 0;
    } else {
      return { running: { id: "fixture", phase: done > 8 ? "switching" : "preparing", step: UPDATE_STEPS[done], steps: UPDATE_STEPS.slice(0, done + 1).map((name, i) => ({ name, status: i < done ? (name === "checks" ? "skipped" : "done") : "running" })) } };
    }
  }
  return { running: null };
}
const updateStatus = () => {
  const { running } = updateView();
  return { status: updates.status, installed: updates.last ? { commit: updates.head, at: new Date().toISOString() } : null, head: updates.head, settings: { auto: updates.auto }, running, last: running ? null : updates.last };
};

function state(id) {
  const conversation = conversations.get(id) ?? conversations.get("1");
  return {
    runtime: "Pi Durable 1.3.0 (preview fixture)",
    providerReady: true,
    update: (() => { const view = updateStatus(); return { state: view.running ? "updating" : view.status.state, behind: view.status.behind }; })(),
    conversationId: id,
    selectedConversationId: id,
    conversationTitle: conversation.title,
    // Workers (child) and side chats (sideOf) nest under their parent, never their own rows.
    conversations: [...conversations]
      .filter(([, row]) => !row.child && !row.sideOf)
      .map(([key, row]) => ({
        id: key,
        title: row.title,
        running: row.running,
        ...(row.channel ? { channel: row.channel } : {}),
        sideChats: [...conversations].filter(([, side]) => side.sideOf === key).reverse().map(([sideId, side]) => ({ id: sideId, title: side.title, running: side.running })),
      })),
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
    ...(conversation.sideOf ? { parentConversationId: conversation.sideOf, sideChatOf: conversation.sideOf } : {}),
    // plan_update: fixture checklist on the main fixture chat; the done one shows collapsed.
    ...(id === "1"
      ? { plan: { steps: [
          { step: "Find the video in the GitHub PR (fixture)", status: "completed" },
          { step: "Work out a CDN URL that serves it", status: "in_progress" },
          { step: "Add Video.js player to the page", status: "pending" },
          { step: "Check it plays in the browser", status: "pending" },
        ], done: 1, total: 4, next: "Work out a CDN URL that serves it" } }
      : id === "7"
        ? { plan: { steps: [{ step: "Draft the notes (fixture)", status: "completed" }, { step: "Check the links", status: "completed" }], done: 2, total: 2, next: null } }
        : {}),
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
        changes: { available: true },
        files: { available: true },
        terminal: { available: true },
        "side-chat": { available: true },
        page: { available: true },
        browser: { available: true },
      },
    });
  if (url.pathname === "/api/workbench/suggestions")
    return json(res, 200, {
      suggestions: [
        { kind: "service", title: "Fixture web app", port: 4173 },
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
    if (url.pathname === "/api/workbench/download") {
      const bytes = rel in files ? Buffer.from(files[rel]) : rel === "assets/mark.png" ? PNG : binaries[rel];
      if (!bytes) return json(res, 404, { error: "Fixture: that file does not exist." });
      const name = rel.split("/").pop();
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      return res.end(bytes);
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
  // workbench lane: changes
  if (url.pathname === "/api/workbench/repos")
    return json(res, 200, {
      repos: [
        { path: "mars-fixture", branch: "fixture/workbench", ahead: 2, behind: 0, dirty: true },
        { path: "notes", branch: "main", ahead: 0, behind: 0, dirty: false },
      ],
    });
  if (url.pathname === "/api/workbench/changes") {
    const repo = url.searchParams.get("repo") ?? "";
    if (repo === "notes") return json(res, 200, { repo, branch: "main", files: [], patch: "", truncated: false });
    if (repo !== "mars-fixture") return json(res, 404, { error: `No git repository at ${repo || "the workspace root"}.` });
    return json(res, 200, {
      repo,
      branch: "fixture/workbench",
      truncated: false,
      files: [
        { path: "FIXTURE.md", status: "?", added: 2, removed: 0, binary: false },
        { path: "assets/fixture-logo.png", status: "M", added: 0, removed: 0, binary: true },
        { path: "docs/old-fixture.md", status: "D", added: 0, removed: 1, binary: false },
        { path: "src/fixture-greeting.ts", status: "M", added: 2, removed: 1, binary: false },
      ],
      patch: [
        "diff --git a/src/fixture-greeting.ts b/src/fixture-greeting.ts",
        "--- a/src/fixture-greeting.ts",
        "+++ b/src/fixture-greeting.ts",
        "@@ -1,3 +1,4 @@",
        " export function greet(name: string) {",
        '-  return "Hello " + name;',
        '+  // Fixture change for the workbench preview.',
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
    });
  }
  // workbench lane: pages
  if (url.pathname === "/api/workbench/pages" || url.pathname.startsWith("/api/workbench/pages/")) {
    const fixturePages = (globalThis.marsFixturePages ??= new Map([
      ["release-plan", { text: "# Release plan (fixture)\n\nFixture page: not a real workspace file.\n\n- [x] Merge the workbench lanes\n- [ ] Run the Bot Box checks\n", modified: Date.now() - 3600000 }],
      ["reading-notes", { text: "# Reading notes (fixture)\n\nA second fixture page.", modified: Date.now() - 86400000 * 2 }],
    ]));
    const pageTitle = (value, name) => /^# +(.+?)\s*#*\s*$/m.exec(value)?.[1].trim() || name;
    const summary = ([name, page]) => ({ name, title: pageTitle(page.text, name), modified: page.modified, size: Buffer.byteLength(page.text) });
    if (req.method === "GET" && url.pathname === "/api/workbench/pages")
      return json(res, 200, { pages: [...fixturePages].map(summary).sort((a, b) => b.modified - a.modified) });
    if (req.method === "GET") {
      const name = url.pathname.slice("/api/workbench/pages/".length);
      const page = fixturePages.get(name);
      return page ? json(res, 200, { name, text: page.text, modified: page.modified }) : json(res, 404, { error: "That page does not exist." });
    }
    if (typeof body.text !== "string") return json(res, 400, { error: "Page text must be a string." });
    let name = body.name;
    if (name === undefined) for (let n = 1; fixturePages.has((name = n === 1 ? "untitled" : `untitled-${n}`)); n++);
    if (!/^[a-z0-9-]{1,64}$/.test(String(name))) return json(res, 400, { error: "Page names use a to z, 0 to 9 and hyphens, up to 64 characters." });
    const current = fixturePages.get(name);
    if (current ? body.baseModified !== current.modified : body.baseModified !== undefined)
      return json(res, 409, { error: "This page changed elsewhere since you opened it.", modified: current?.modified ?? 0 });
    fixturePages.set(name, { text: body.text, modified: Math.max(Date.now(), (current?.modified ?? 0) + 1) });
    return json(res, current ? 200 : 201, summary([name, fixturePages.get(name)]));
  }
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
  // workbench lane: browser
  // A labelled fixture web app on "port 4173", served here. It has root-relative CSS,
  // JS, a root-relative fetch and a second page, like a real dev server. No real
  // service is reached and keys are fixture values.
  {
    const FIXTURE_PORT = 4173;
    const KEY = "fixture-browse-key-not-a-secret-0123456789a";
    if (url.pathname === "/api/workbench/services") return json(res, 200, { services: [{ port: FIXTURE_PORT, title: "Fixture web app", status: 200 }] });
    if (url.pathname === "/api/workbench/browse-key" && req.method === "POST")
      return Number(body.port) === FIXTURE_PORT ? json(res, 201, { key: KEY, port: FIXTURE_PORT }) : json(res, 403, { error: `localhost:${body.port} is not a running local web service the workbench can open.` });
    if (url.pathname === "/api/workbench/browse-key/revoke") return json(res, 200, { revoked: true });
    const browse = /^\/api\/workbench\/browse\/(\d+)\/~([A-Za-z0-9_-]{43})(\/.*)?$/.exec(url.pathname);
    if (browse) {
      const sandbox = { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'", "referrer-policy": "no-referrer", "access-control-allow-origin": "null" };
      if (Number(browse[1]) !== FIXTURE_PORT || browse[2] !== KEY) return res.writeHead(401, { ...sandbox, "content-type": "application/json" }), res.end('{"error":"Unknown browse key"}');
      const prefix = `/api/workbench/browse/${FIXTURE_PORT}/~${KEY}`;
      const page = (title, inner) =>
        `<!doctype html><html><head><base href="${prefix}/"><script>(()=>{const P=${JSON.stringify(prefix)};const f=window.fetch;window.fetch=(i,o)=>f(typeof i==="string"&&i.startsWith("/")&&!i.startsWith(P)?P+i:i,o);const tell=()=>parent.postMessage({marsBrowse:location.pathname+location.search},"*");addEventListener("popstate",tell);tell();})();</script><title>${title}</title><link rel="stylesheet" href="${prefix}/assets/site.css"></head><body><header><strong>Fixture web app</strong> <small>served by the preview fixture, not a real service</small></header>${inner}<script type="module" src="${prefix}/assets/app.js"></script></body></html>`;
      const files = {
        "/": ["text/html", page("Fixture web app", `<h1>Hello from localhost:${FIXTURE_PORT}</h1><p id="status">Loading data…</p><p><a href="${prefix}/about">About this fixture</a></p>`)],
        "/about": ["text/html", page("About the fixture", `<h1>About</h1><p>A second page, reached by a link inside the frame.</p><p><a href="${prefix}/">Home</a></p>`)],
        "/assets/site.css": ["text/css", "body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1f1e1d;background:#faf9f5}header{padding:12px 20px;border-bottom:1px solid #e5e2da}header small{color:#77736a;margin-left:6px}h1,p{margin:16px 20px}h1{font-size:22px}a{color:#c15f3c}#status[data-ok]{color:#2f7d4f}"],
        "/assets/app.js": ["text/javascript", `const s=document.getElementById("status");if(s)fetch("/api/hello").then(r=>r.json()).then(d=>{s.textContent=d.message;s.dataset.ok=""}).catch(()=>{s.textContent="The fetch failed."});`],
        "/api/hello": ["application/json", JSON.stringify({ message: "Fetched /api/hello through the proxy (fixture data)." })],
      };
      const file = files[browse[3] || "/"];
      if (!file) return res.writeHead(404, { ...sandbox, "content-type": "text/plain" }), res.end("Fixture: not found");
      res.writeHead(200, { ...sandbox, "content-type": file[0], "cache-control": "no-store" });
      return res.end(file[1]);
    }
  }
  // Gateway (docs/GATEWAY.md): Telegram linked to conversation 3, one pending pairing.
  if (url.pathname === "/api/gateway/pairings" && req.method === "POST") {
    gateway.pairings = gateway.pairings.filter((p) => p.code !== body.code);
    if (body.approve) gateway.audit.unshift({ at: new Date().toISOString(), channel: "telegram", decision: "paired" });
    return json(res, 200, { channel: "telegram", sender: "5550002", approved: !!body.approve });
  }
  if (url.pathname === "/api/gateway/bindings/delete" && req.method === "POST") {
    gateway.bindings = gateway.bindings.filter((b) => b.route !== body.route);
    return json(res, 200, { unbound: body.route });
  }
  // Tests reset the fixture gateway first, so one run's approval does not leak into the next.
  if (url.pathname === "/api/gateway/fixture-reset" && req.method === "POST") return json(res, 200, (gateway = freshGateway()));
  if (url.pathname === "/api/gateway") return json(res, 200, gateway);
  if (url.pathname === "/api/update/fixture-reset" && req.method === "POST") { updates = freshUpdates(); if (body.state === "needs_reconcile") Object.assign(updates.status, { state: "needs_reconcile", ahead: 1, blockers: [{ code: "conflict", message: "This copy and main both changed the same lines. Merge them by hand (git merge origin/main) or ask Mars to reconcile.", files: ["apps/ui/components/composer/composer.tsx"] }], next: "This copy and main both changed the same lines." }); return json(res, 200, updateStatus()); }
  if (url.pathname === "/api/update" && req.method === "GET") return json(res, 200, updateStatus());
  if (url.pathname === "/api/update/check" && req.method === "POST") { updates.status = { ...updates.status, checkedAt: new Date().toISOString() }; return json(res, 200, updateStatus()); }
  if (url.pathname === "/api/update/settings" && req.method === "POST") {
    if (typeof body.auto !== "boolean") return json(res, 400, { error: "Send { auto: true } or { auto: false }" });
    updates.auto = body.auto;
    return json(res, 200, updateStatus());
  }
  if (url.pathname === "/api/update/apply" && req.method === "POST") {
    if (!["fast_forward", "merge"].includes(updates.status.state) || updates.startedAt) return json(res, 202, { started: false, outcome: "nothing_to_do", detail: updates.status.next, next: updates.status.next });
    updates.startedAt = Date.now();
    return json(res, 202, { started: true, outcome: "started", detail: "Updating to 9a41e02b7c10 (2 new commits).", next: "Mars builds the new version first, then restarts." });
  }
  if (url.pathname === "/api/plugins") return json(res, 200, { plugins: [] });
  if (url.pathname === "/api/connections")
    return json(res, 200, {
      discord: { configured: false, connected: false, guildId: null },
      opencode: { configured: false, enabled: false },
    });
  if (url.pathname === "/api/conversations" && req.method === "POST") {
    const next = String(Math.max(...[...conversations.keys()].map(Number)) + 1);
    const parent = body.parentId === undefined ? undefined : String(body.parentId);
    if (parent !== undefined && (!conversations.has(parent) || conversations.get(parent).sideOf || conversations.get(parent).child))
      return json(res, 400, { error: "A side chat needs a top-level parent conversation" });
    const title = body.title || (parent ? "Side chat" : "New conversation");
    conversations.set(next, { title, running: false, entries: [], ...(parent ? { sideOf: parent } : {}) });
    return json(res, 201, { conversation: { id: next, title, ...(parent ? { parentId: parent } : {}) } });
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
