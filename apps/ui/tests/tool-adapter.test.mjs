import assert from "node:assert/strict";
import test from "node:test";
import { parseSnapshot } from "../lib/pi/live-state.ts";
import {
  bashStep,
  diffInput,
  editStep,
  parsePatch,
  summarise,
  toolStatus,
  toolView,
  toolViews,
} from "../components/ai/tool-adapter.ts";

const call = (name, args, extra = {}) => ({
  id: name,
  name,
  input: JSON.stringify(args),
  failed: false,
  ...extra,
});

test("status comes only from Pi state, failure and output", () => {
  assert.equal(toolStatus(call("bash", {}, { output: "ok", state: "complete" })), "complete");
  assert.equal(toolStatus(call("bash", {}, { output: "ok" })), "complete");
  assert.equal(toolStatus(call("bash", {})), "running");
  assert.equal(toolStatus(call("bash", {}, { output: "partial", state: "running" })), "running");
  assert.equal(toolStatus(call("bash", {}, { output: "no", failed: true, state: "failed" })), "failed");
  assert.equal(toolStatus(call("bash", {}, { state: "cancelled" })), "cancelled");
  assert.equal(toolStatus(call("bash", {}, { state: "complete" })), "complete");
});

test("bash keeps command, output, exit code and failure for the terminal card", () => {
  const view = toolView(
    call("bash", { command: "npm test\nnpm run build" }, {
      output: "not ok 3",
      failed: true,
      exitCode: 1,
      details: { truncated: true },
    }),
  );
  assert.equal(view.kind, "command");
  assert.equal(view.title, "Run command");
  assert.equal(view.detail, "npm test");
  assert.equal(view.exitCode, 1);
  assert.equal(view.truncated, true);
  const step = bashStep(view);
  assert.equal(step.bashCommand, "npm test\nnpm run build");
  assert.equal(step.bashOutput, "not ok 3");
  assert.equal(step.bashSuccess, false);
  assert.equal(toolView(call("powershell", { command: "dir" }, { output: "" })).kind, "command");
});

test("durations and exit codes are never invented", () => {
  const view = toolView(call("bash", { command: "true" }, { output: "" }));
  assert.equal(view.durationMs, undefined);
  assert.equal(view.exitCode, undefined);
  assert.equal(view.status, "complete");
});

test("edit prefers the Pi unified patch over the raw replacement", () => {
  const patch =
    "--- scripts/deploy-host.mjs\n+++ scripts/deploy-host.mjs\n@@ -41,2 +41,4 @@\n const marker = lockMarker(stage);\n-if (existsSync(checkoutLock)) return;\n+if (!existsSync(marker)) {\n+  await install();\n+}\n";
  const view = toolView(
    call("edit", { path: "scripts/deploy-host.mjs", edits: [{ oldText: "a", newText: "b" }] }, {
      output: "Replaced",
      details: { patch },
    }),
  );
  assert.equal(view.kind, "edit");
  assert.equal(view.files.length, 1);
  assert.deepEqual(
    view.files[0].lines.map((line) => line.type),
    ["context", "remove", "add", "add", "add"],
  );
  assert.deepEqual(diffInput(view.files[0]), {
    old_string: "const marker = lockMarker(stage);\nif (existsSync(checkoutLock)) return;\n",
    new_string: "const marker = lockMarker(stage);\nif (!existsSync(marker)) {\n  await install();\n}\n",
  });
  const step = editStep(view, view.files[0]);
  assert.equal(step.toolName, "Edit");
  assert.equal(step.filePath, "scripts/deploy-host.mjs");
  assert.equal(step.diffStats, "+3 -1");
});

test("edit without a patch falls back to its oldText/newText pairs", () => {
  const view = toolView(
    call("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two\nthree" }] }, { output: "ok" }),
  );
  assert.deepEqual(view.files[0].lines, [
    { type: "remove", content: "one" },
    { type: "add", content: "two" },
    { type: "add", content: "three" },
  ]);
  const write = toolView(call("write", { path: "new.md", content: "# Hi\n" }, { output: "ok" }));
  assert.equal(write.created, true);
  assert.equal(editStep(write, write.files[0]).toolName, "Write");
});

test("apply_patch splits a git patch into one diff per file", () => {
  const patch =
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" +
    "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n";
  assert.deepEqual(
    parsePatch(patch).map((file) => [file.path, file.added, file.removed]),
    [
      ["a.txt", 1, 1],
      ["new.txt", 1, 0],
    ],
  );
  const view = toolView(call("apply_patch", { patch, cwd: "repo" }, { output: "{}" }));
  assert.equal(view.files.length, 2);
  assert.equal(summarise([view]), "Edited 2 files");
});

test("read, search and unknown tools map to their quiet rows", () => {
  const read = toolView(call("read", { path: "notes.md" }, { output: "x" }));
  assert.deepEqual([read.kind, read.title, read.detail], ["read", "Read file", "notes.md"]);
  const search = toolView(call("web_search", { query: "npm workspaces" }, { output: "1." }));
  assert.deepEqual([search.kind, search.detail], ["search", "npm workspaces"]);
  assert.equal(toolView(call("web_fetch", { url: "https://x.dev" })).detail, "https://x.dev");
  assert.equal(toolView(call("tool_search", { query: "deploy" })).title, "Find tools");
  const unknown = toolView(call("discovery_reset", {}, { output: "done" }));
  assert.deepEqual([unknown.kind, unknown.title], ["generic", "Discovery reset"]);
  assert.equal(toolView({ ...call("bash", {}), input: "not json" }).command, "");
});

test("codemode is listed as the nested calls it made, with their real outcomes", () => {
  const state = parseSnapshot({
    runtime: "Pi",
    conversationId: 1,
    auth: { connected: true },
    view: {
      docs: {},
      entries: [
        { id: 1, model: [{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode", arguments: {} }] }] },
        {
          id: 2,
          model: [
            {
              role: "toolResult",
              toolCallId: "c",
              content: "Finished",
              details: {
                calls: [
                  { id: 1, name: "host_read", args: '{"path":"note.txt"}', status: "ok", durationMs: 10 },
                  { id: 2, name: "host_exec", args: '{"command":"false"}', status: "error", error: "Command failed" },
                ],
              },
            },
          ],
        },
      ],
    },
  });
  const views = toolViews(state.messages[0].tools);
  assert.deepEqual(
    views.map((view) => [view.title, view.status]),
    [
      ["Read file", "complete"],
      ["Run command", "failed"],
    ],
  );
  assert.equal(views[0].durationMs, 10);
  assert.equal(views[1].output, "Command failed");
  assert.equal(summarise(views), "Read 1 file, ran 1 command");
  assert.equal(toolViews([call("codemode", { code: "1" }, { output: "1" })])[0].title, "Run code");
});

test("group summary counts like Claude and ignores malformed metadata", () => {
  const views = toolViews([
    call("bash", { command: "a" }, { output: "" }),
    call("bash", { command: "b" }, { output: "" }),
    call("bash", { command: "c" }, { output: "" }),
    call("read", { path: "x" }, { output: "" }),
    null,
    "junk",
    call("web_search", { query: "q" }, { output: "" }),
    call("web_search", { query: "r" }, { output: "" }),
  ]);
  assert.equal(views.length, 6);
  assert.equal(summarise(views), "Ran 3 commands, read 1 file, searched the web 2 times");
  assert.equal(summarise([]), "");
});
