import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Workbench host routes (docs/WORKBENCH.md). `handle(req, res, url)` returns true when
 * it answered. The caller has already authenticated the owner and checked the origin.
 */
export function createWorkbench({ work, send, jsonBody, tools = {}, extensionUis = () => [] }) {
  const ready = mkdir(work, { recursive: true });
  let python;
  async function hasPython() {
    python ??= run("python3", ["-c", "import pty"], { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    return python;
  }
  async function capabilities() {
    const reasons = {
      // lane: changes. git can be missing at runtime.
      changes: tools.changes ? ((await tools.changes.available()).reason ?? "") : "Changes is not built into this host yet.",
      files: tools.files ? "" : "Files is not built into this host yet.",
      terminal: tools.terminal ? (await tools.terminal.available()).reason : "Terminal is not built into this host yet.", // lane: terminal (the module probes python3 and pty)
      "side-chat": "",
      page: tools.pages ? "" : "Pages are not built into this host yet.",
      browser: tools.browser ? (await tools.browser.available()).reason : "Browser is not built into this host yet.", // lane: browser (lsof or ss)
    };
    return {
      tools: Object.fromEntries(Object.entries(reasons).map(([key, reason]) => [key, reason ? { available: false, reason } : { available: true }])),
    };
  }
  async function suggestions() {
    const rows = [];
    if (tools.browser) for (const service of await tools.browser.services()) rows.push({ kind: "service", title: service.title || `localhost:${service.port}`, port: service.port });
    for (const extension of extensionUis()) rows.push({ kind: "extension", title: extension.title, hash: extension.hash });
    if (tools.pages) for (const page of (await tools.pages.list()).slice(0, 5)) rows.push({ kind: "page", title: page.title, name: page.name });
    return { suggestions: rows };
  }
  return {
    /** Before owner auth: only a browse path with a valid key for its port (lane: browser). */
    async handleKeyed(req, res, url) {
      return tools.browser ? tools.browser.handleKeyed(req, res, url, { send }) : false;
    },
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/api/workbench/")) return false;
      await ready;
      const route = url.pathname.slice("/api/workbench/".length);
      if (req.method === "GET" && route === "capabilities") return send(res, 200, await capabilities()), true;
      if (req.method === "GET" && route === "suggestions") return send(res, 200, await suggestions()), true;
      for (const tool of Object.values(tools)) if (tool && (await tool.handle(req, res, url, route, { send, jsonBody }))) return true;
      send(res, 404, { error: "Unknown workbench route" });
      return true;
    },
  };
}
