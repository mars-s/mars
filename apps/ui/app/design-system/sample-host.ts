// In-page sample answers for the /design-system workbench specimens. Nothing here reaches Pi:
// while a specimen is mounted, fetches to these routes are answered locally, and the real
// fetch is restored when it unmounts. Every value is illustrative.

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });
const NOW = Date.parse("2026-10-21T09:30:00+11:00");

const files: Record<string, string> = {
  "README.md":
    "# Sample workspace\n\nIllustrative files for the design system. Nothing here is a real Pi workspace.\n\n- [Release notes](notes/release.md)\n- [Deploy script](scripts/deploy.sh)\n\n| Pane | Purpose |\n| --- | --- |\n| Files | Read the workspace |\n| Changes | Review git diffs |\n",
  "notes/release.md": "# Release plan\n\n1. Merge the workbench lanes.\n2. Run every gate.\n",
  "scripts/deploy.sh": '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")/.."\nnpm ci\nnpm run build\n',
  "src/greet.ts": "export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n",
};
const dirs = ["", "notes", "scripts", "src"];
function listing(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, "dir" | "file">();
  for (const path of [...dirs.filter(Boolean), ...Object.keys(files)]) {
    if (!path.startsWith(prefix) || path === dir) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    if (!seen.has(name)) seen.set(name, rest.length || dirs.includes(prefix + name) ? "dir" : "file");
  }
  const entries = [...seen]
    .map(([name, type]) => ({ name, type, size: files[prefix + name]?.length ?? 0, modified: NOW }))
    .sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  return { path: dir, entries, truncated: false };
}

const patch = [
  "diff --git a/src/greet.ts b/src/greet.ts",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string) {",
  '-  return "Hello " + name;',
  "+  // Friendlier punctuation.",
  "+  return `Hello, ${name}`;",
  " }",
  "diff --git a/NOTES.md b/NOTES.md",
  "--- /dev/null",
  "+++ b/NOTES.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+An untracked file shows as an addition.",
  "",
].join("\n");

const pages = new Map([
  ["release-plan", { text: "# Release plan\n\nSample page.\n\n- [x] Merge the workbench lanes\n- [ ] Run the checks\n", modified: NOW - 3_600_000 }],
  ["reading-notes", { text: "# Reading notes\n\nA second sample page.", modified: NOW - 172_800_000 }],
]);
const pageTitle = (text: string, name: string) => /^# +(.+?)\s*#*\s*$/m.exec(text)?.[1].trim() || name;

const sideChat = {
  runtime: "Sample",
  providerReady: true,
  conversationId: "902",
  selectedConversationId: "902",
  conversationTitle: "Name the release",
  conversations: [],
  auth: { connected: true, state: "connected", events: [] },
  models: [{ id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" }],
  view: {
    entries: [
      { id: 1, model: [{ role: "user", content: [{ type: "text", text: "Three names for the workbench release?" }] }] },
      {
        id: 2,
        model: [{ role: "assistant", content: [{ type: "text", text: "**Split Pane**, **Side Table** or **Second Desk**. Second Desk reads best beside the chat." }] }],
      },
    ],
    docs: { "pi.agent": { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } },
  },
};

const shell = new Map<string, { out: string; line: string }>();
const PROMPT = "\x1b[2msample\x1b[0m:workspace $ ";

function answer(url: URL, method: string, body: Record<string, unknown>): Answer | undefined {
  const path = url.pathname;
  const param = url.searchParams.get("path") ?? "";
  if (path === "/api/workbench/capabilities")
    return ok({ tools: Object.fromEntries(["changes", "files", "terminal", "side-chat", "page", "browser"].map((tool) => [tool, { available: true }])) });
  if (path === "/api/workbench/suggestions")
    return ok({ suggestions: [{ kind: "service", title: "Docs site", port: 3100 }, { kind: "page", title: "Release plan", name: "release-plan" }] });
  if (path === "/api/workbench/files") return dirs.includes(param) ? ok(listing(param)) : { status: 404, body: { error: "No such folder." } };
  if (path === "/api/workbench/file")
    return param in files
      ? ok({ path: param, size: files[param].length, modified: NOW, kind: "text", text: files[param], truncated: false })
      : { status: 404, body: { error: "No such file." } };
  if (path === "/api/workbench/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return ok({ results: Object.keys(files).filter((file) => file.toLowerCase().includes(q)).map((file) => ({ path: file, type: "file" })), truncated: false, timedOut: false });
  }
  if (path === "/api/workbench/repos") return ok({ repos: [{ path: "mars", branch: "codex/workbench", ahead: 2, behind: 0, dirty: true }] });
  if (path === "/api/workbench/changes")
    return ok({
      repo: "mars",
      branch: "codex/workbench",
      truncated: false,
      patch,
      files: [
        { path: "NOTES.md", status: "?", added: 2, removed: 0, binary: false },
        { path: "src/greet.ts", status: "M", added: 2, removed: 1, binary: false },
      ],
    });
  if (path === "/api/workbench/pages" && method === "GET")
    return ok({
      pages: [...pages].map(([name, page]) => ({ name, title: pageTitle(page.text, name), modified: page.modified, size: page.text.length })),
    });
  if (path.startsWith("/api/workbench/pages/")) {
    const name = path.slice("/api/workbench/pages/".length);
    const page = pages.get(name);
    return page ? ok({ name, text: page.text, modified: page.modified }) : { status: 404, body: { error: "No such page." } };
  }
  if (path === "/api/workbench/pages") {
    const name = typeof body.name === "string" ? body.name : "untitled";
    const text = typeof body.text === "string" ? body.text : "";
    const modified = Math.max(Date.now(), (pages.get(name)?.modified ?? 0) + 1);
    pages.set(name, { text, modified });
    return ok({ name, title: pageTitle(text, name), modified, size: text.length });
  }
  if (path === "/api/state" && url.searchParams.get("conversationId") === "902") return ok(sideChat);
  if (path === "/api/workbench/terminal" && method === "POST") {
    const id = "a1b2c3d4e5f6a1b2c3d4e5f6";
    shell.set(id, { out: `Sample shell for the design system. Nothing runs.\r\n${PROMPT}`, line: "" });
    return { status: 201, body: { id } };
  }
  const terminal = /^\/api\/workbench\/terminal\/([a-f0-9]{24})(?:\/(input|resize|kill))?$/.exec(path);
  if (terminal) {
    const session = shell.get(terminal[1]);
    if (!session) return { status: 404, body: { error: "Terminal session not found" } };
    if (terminal[2] === "input") {
      for (const char of atob(String(body.data ?? ""))) {
        if (char === "\r") {
          session.out += `\r\n${session.line.trim() ? `sample: ${session.line.trim()}: nothing runs here\r\n` : ""}${PROMPT}`;
          session.line = "";
        } else if (char >= " ") {
          session.line += char;
          session.out += char;
        }
      }
      return ok({ accepted: 1 });
    }
    if (terminal[2]) return ok({ cols: body.cols, rows: body.rows });
    const since = Number(url.searchParams.get("since") ?? 0);
    const bytes = new TextEncoder().encode(session.out);
    return ok({ offset: bytes.length, data: btoa(String.fromCharCode(...bytes.subarray(since))) });
  }
  return undefined;
}

/** Answer sample routes in this page until the returned function is called. */
export function installSampleHost(): () => void {
  const real = window.fetch;
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), location.href);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string")
      try {
        body = JSON.parse(init.body);
      } catch {}
    const reply = url.origin === location.origin ? answer(url, method, body) : undefined;
    if (!reply) return real(input, init);
    // A terminal poll with nothing new waits a moment, like the host's long poll.
    if (/\/terminal\/[a-f0-9]{24}$/.test(url.pathname)) await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return () => {
    window.fetch = real;
  };
}
