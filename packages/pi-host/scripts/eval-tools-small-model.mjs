// Small-model tool evaluation (docs/TOOLS.md "Measuring it"). Offers every Mars tool to a
// local model through Ollama and grades, per request: the right tool, schema-valid
// arguments, and arguments that mean what was asked. Free and offline; opt-in, not a gate.
//
//   ollama pull qwen2.5:1.5b && ollama serve &
//   node scripts/eval-tools-small-model.mjs [tools.json ...]
//
// With no files it dumps the current host's tools. Several files (e.g. a before and an
// after dump made with MARS_DUMP_TOOLS) are compared side by side.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
const MODEL = process.env.EVAL_MODEL || "qwen2.5:1.5b";
const RUNS = Number(process.env.EVAL_RUNS || 3);
const UPSTREAM = new Set(["codemode", "tool_search", "read", "write", "edit", "bash"]);
const TASKS = [
  ["Run the test suite with `npm test` in the projects/site folder.", "host_exec", (a) => /npm test/.test(a.command ?? "")],
  ["The last command printed a lot of output with saved id 3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13. Read the next part of it starting at byte 4096.", "artefact_read", (a) => a.id === "3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13" && a.offset === 4096],
  ["Find every line containing 'Error' in saved output 3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13.", "artefact_search", (a) => a.query === "Error"],
  ["Ask a cheap fast helper model to summarise notes/README.md in three bullet points, and wait for its answer.", "worker_run", (a) => typeof a.task === "string" && /README/i.test(a.task) && (!a.model || a.model === "luna")],
  ["Review three files at the same time: review a.ts, b.ts and c.ts for bugs, each by its own helper.", "worker_fanout", (a) => Array.isArray(a.jobs) && a.jobs.length === 3],
  ["Start a background process that first researches tide pools and then writes a short blog post from the research.", "workflow_start", (a) => Array.isArray(a.steps) && a.steps.length >= 2],
  ["Open a side chat called 'Release names' that starts working on suggesting three release names. The owner wants to follow it separately.", "side_chat_open", (a) => /release/i.test(a.title ?? "") && typeof a.task === "string"],
  ["Send 'Make them shorter' to side chat 42.", "side_chat_send", (a) => a.sideChatId === "42" && /shorter/i.test(a.text ?? "")],
  ["Give the owner a link to download the file exports/report.csv.", "workspace_file_link", (a) => a.path === "exports/report.csv"],
  ["What is the latest stable version of Node.js? Look it up online.", "web_search", (a) => /node/i.test(a.query ?? "")],
  ["Read the full page at https://nodejs.org/en/about/previous-releases.", "web_fetch", (a) => a.url === "https://nodejs.org/en/about/previous-releases"],
  ["Turn off the web_fetch tool of the web-search plugin.", "plugin_configure", (a) => a.name === "web-search" && a.tools?.web_fetch === false],
  ["Check whether the latest host deploy finished or rolled back.", "host_deploy_status", () => true],
  ["Read the interface source file components/shell/header.tsx before changing it.", "ui_source_read", (a) => a.path === "components/shell/header.tsx"],
  // Choosing how to run multi-step work: you do it (plan), in order by helpers (workflow), or at once (fanout).
  ["I am about to do these myself, one by one: find the video in the PR, work out a CDN URL, add the player, check it plays. Show the owner my checklist with the first step in progress.", "plan_update", (a) => Array.isArray(a.steps) && a.steps.length === 4 && a.steps[0].status === "in_progress"],
  ["I have finished step 1 of my checklist and am starting step 2. Steps: 'Run tests', 'Fix failures', 'Commit'. Update the checklist the owner sees.", "plan_update", (a) => Array.isArray(a.steps) && a.steps[0]?.status === "completed" && a.steps[1]?.status === "in_progress"],
  ["Have helper models do this in the background, in order: first research tide pools, then write a post from that research.", "workflow_start", (a) => Array.isArray(a.steps) && a.steps.length >= 2],
  // Changing Mars itself: isolated worktree, check, then a dry run before any real deploy (docs/SELF-EDIT.md).
  ["I want to change the Mars host code so plan steps are trimmed. Start that change safely, without touching the live checkout.", "self_edit_start", (a) => typeof a.title === "string" && /plan|trim/i.test(a.title)],
  ["I have edited files in self-edit trim-plan-steps-3f2a. Check them before committing.", "self_edit_check", (a) => a.id === "trim-plan-steps-3f2a" && (!a.scope || a.scope === "related")],
  ["Self-edit trim-plan-steps-3f2a passed its checks. Commit it and test it with a dry run, without restarting the host.", "self_edit_finish", (a) => a.id === "trim-plan-steps-3f2a" && (!a.deploy || a.deploy === "dry_run")],
  ["The dry run of self-edit trim-plan-steps-3f2a passed. Ship it to the live host now.", "self_edit_finish", (a) => a.id === "trim-plan-steps-3f2a" && a.deploy === "deploy"],
  ["Throw away self-edit trim-plan-steps-3f2a; it is not worth finishing.", "self_edit_abandon", (a) => a.id === "trim-plan-steps-3f2a"],
];
const toTool = (row) => ({ type: "function", function: { name: row.name, description: row.description, parameters: row.parameters ?? { type: "object", properties: {} } } });

async function ask(tools, task) {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL, stream: false, tools, options: { temperature: 0.7, seed: Math.floor(Math.random() * 1e9) },
      messages: [
        { role: "system", content: "You are an assistant with tools. Use exactly one tool call to do the user's request." },
        { role: "user", content: task },
      ],
    }),
  });
  const data = await response.json();
  const call = data.message?.tool_calls?.[0]?.function;
  if (!call) return { name: null, args: null };
  let args = call.arguments;
  if (typeof args === "string") try { args = JSON.parse(args); } catch { args = null; }
  return { name: call.name, args };
}

function dumpCurrent() {
  const base = mkdtempSync(join(tmpdir(), "mars eval "));
  const out = join(base, "tools.json");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    cwd: base,
    env: { ...process.env, MARS_PI_ROOT: join(base, "data"), MARS_PI_PORT: "39181", MARS_UI_PORT: "39182", MARS_PI_STAGING: "1", MARS_DUMP_TOOLS: out },
  });
  if (run.status !== 0) throw Error("Could not dump the host tools: " + run.stderr);
  return out;
}
const files = process.argv.length > 2 ? process.argv.slice(2) : [dumpCurrent()];
for (const file of files) {
  const rows = JSON.parse(readFileSync(file, "utf8")).filter((r) => !UPSTREAM.has(r.name));
  const version = file;
  const tools = rows.map(toTool);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  let right = 0, valid = 0, intent = 0, total = 0;
  const misses = [];
  for (const [task, expected, wants] of TASKS) {
    for (let run = 0; run < RUNS; run++) {
      const { name, args } = await ask(tools, task);
      total++;
      if (name === expected) {
        right++;
        const schema = byName[expected].parameters;
        const ok = args && (!schema || Compile(schema).Check(args));
        if (ok) valid++;
        if (ok && wants(args)) intent++;
        else misses.push(`${expected}: ${JSON.stringify(args)?.slice(0, 120)}`);
      } else misses.push(`${expected} -> picked ${name} ${JSON.stringify(args)?.slice(0, 120) ?? ""}`);
    }
  }
  console.log(`${MODEL} x${RUNS} on ${version}: right tool ${right}/${total}, valid args ${valid}/${total}, fully correct ${intent}/${total}`);
  for (const miss of misses) console.log(`  miss: ${miss}`);
}
