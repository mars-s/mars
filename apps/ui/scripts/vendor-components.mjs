// Vendor selected AI components from their public shadcn registries into
// components/vendor/<source>/ and write a source register with content hashes.
// Rerun with: node scripts/vendor-components.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = {
  kokonut: {
    url: (name) => `https://kokonutui.com/r/${name}.json`,
    licence: "MIT, Copyright (c) 2025 kokonutUI (github.com/kokonut-labs/kokonutui)",
    items: [
      "ai-prompt", "ai-model-selector", "ai-context-meter", "ai-tool-approval", "ai-diff-review",
      "ai-citations", "ai-loading", "ai-text-loading", "ai-voice", "file-upload",
      "action-search-bar", "status-island",
    ],
  },
  "agent-elements": {
    url: (name) => `https://agent-elements.21st.dev/r/${name}.json`,
    licence: "MIT, Copyright (c) 2026 21st.dev (github.com/21st-dev/agent-elements)",
    items: [
      "edit-tool", "bash-tool", "search-tool", "plan-tool", "todo-tool", "tool-group",
      "subagent-tool", "question-tool", "mcp-tool", "generic-tool", "thinking-tool",
    ],
  },
  "assistant-ui": {
    url: (name) => `https://r.assistant-ui.com/${name}.json`,
    licence: "MIT, Copyright (c) 2026 AgentbaseAI Inc. (github.com/assistant-ui/assistant-ui)",
    items: [
      "elements-background-inbox", "elements-artifact-card", "elements-checkpoint-history",
      "elements-schedule-card", "elements-connection-state", "elements-context-breakdown",
      "elements-memory-chips", "elements-elicitation-form", "elements-cost-meter",
    ],
  },
  "ai-elements": {
    url: (name) => `https://ai-sdk.dev/elements/api/registry/${name}.json`,
    licence: "Apache-2.0, Copyright 2023 Vercel, Inc. (github.com/vercel/ai-elements)",
    items: ["chain-of-thought", "sources", "task"],
  },
};

const fetched = new Map();
async function item(source, ref) {
  const name = ref.replace(/^https?:\/\/[^ ]+\/r\//, "").replace(/\.json$/, "").split("/").pop();
  const key = `${source}:${name}`;
  if (fetched.has(key)) return;
  fetched.set(key, null);
  const response = await fetch(sources[source].url(name), { redirect: "follow" });
  if (!response.ok) throw Error(`${key}: HTTP ${response.status}`);
  const json = await response.json();
  fetched.set(key, json);
  for (const dependency of json.registryDependencies ?? []) {
    // Bare names are base shadcn primitives (button, collapsible); we use our own.
    if (dependency.includes("/") || dependency.endsWith(".json")) await item(source, dependency);
    else baseNeeds.add(dependency);
  }
}
const baseNeeds = new Set();

// Keep each upstream tree intact so its relative imports keep resolving.
const layout = {
  kokonut: [[/^components\/kokonutui\//, ""], [/^hooks\//, "hooks/"]],
  "agent-elements": [[/^components\/agent-elements\//, ""]],
  "assistant-ui": [[/^components\/assistant-ui\//, ""]],
  "ai-elements": [[/^components\/ai-elements\//, ""]],
};
function target(source, path) {
  let clean = path.replace(/^\/+/, "");
  for (const [pattern, replacement] of layout[source]) clean = clean.replace(pattern, replacement);
  return posix.join("components/vendor", source, clean);
}

function rewrite(source, file, content) {
  return content
    .replace(/(["'])@\/lib\/utils\1/g, '"@/lib/utils"')
    .replace(/(["'])@\/hooks\/([^"']+)\1/g, `"@/components/vendor/${source}/hooks/$2"`)
    .replace(/(["'])@\/components\/ai-elements\/([^"']+)\1/g, `"@/components/vendor/ai-elements/$2"`)
    .replace(/(["'])@\/registry\/[^"']*\/ai-elements\/([^"']+)\1/g, `"@/components/vendor/ai-elements/$2"`)
    .replace(/(["'])@\/registry\/[^"']*\/ui\/([^"']+)\1/g, `"@/components/ui/$2"`);
}

const register = [];
for (const [source, config] of Object.entries(sources))
  for (const name of config.items) await item(source, name);

const packages = new Set();
for (const [key, json] of fetched) {
  const [source] = key.split(":");
  for (const dependency of json.dependencies ?? []) packages.add(dependency);
  for (const file of json.files ?? []) {
    if (!file.content) continue;
    const path = target(source, file.target || file.path);
    const content = rewrite(source, path, file.content);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    register.push({
      source,
      item: json.name,
      registry: sources[source].url(json.name),
      path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    });
  }
}

const retrieved = new Date().toISOString().slice(0, 10);
const lines = [
  "# Vendored component register",
  "",
  `Retrieved ${retrieved} by scripts/vendor-components.mjs. Hashes are of the upstream file before import-path rewriting.`,
  "Upgrade by rerunning the script and reviewing the diff. Mars wrappers live outside components/vendor.",
  "",
  "| Source | Licence |",
  "| --- | --- |",
  ...Object.entries(sources).map(([source, config]) => `| ${source} | ${config.licence} |`),
  "",
  "| Source | Item | File | SHA-256 |",
  "| --- | --- | --- | --- |",
  ...register.map((row) => `| ${row.source} | [${row.item}](${row.registry}) | ${row.path} | ${row.sha256.slice(0, 16)} |`),
  "",
];
writeFileSync(join(root, "components/vendor/SOURCES.md"), lines.join("\n"));
console.log(JSON.stringify({ files: register.length, packages: [...packages].sort(), baseShadcn: [...baseNeeds].sort() }, null, 2));
