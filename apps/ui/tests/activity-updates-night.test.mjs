// Activity timeline outcomes (apps/ui/docs/IMAGES-SUBTHREADS.md, Activity): a codemode script
// that failed or was stopped keeps its own failed row and error after its nested calls, and a
// failed or stopped edit or write lists no diff, so its error shows instead.
import assert from "node:assert/strict";
import test from "node:test";
import { parseSnapshot } from "../lib/pi/live-state.ts";
import { summarise, toolViews } from "../components/ai/tool-adapter.ts";

const call = (name, args, extra = {}) => ({ id: name, name, input: JSON.stringify(args), failed: false, ...extra });
const outcomes = (views) => views.map((view) => [view.title, view.status, view.output]);

function codemodeSnapshot(result) {
  return parseSnapshot({
    runtime: "Pi",
    conversationId: 1,
    auth: { connected: true },
    view: {
      docs: {},
      entries: [
        { id: 1, model: [{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode", arguments: { code: "x" } }] }] },
        { id: 2, model: [{ role: "toolResult", toolCallId: "c", ...result }] },
      ],
    },
  });
}

test("a codemode script that throws after a good nested call shows as failed, with its error", () => {
  const state = codemodeSnapshot({
    content: "Error: boom",
    isError: true,
    details: { calls: [{ id: 1, name: "host_exec", args: '{"command":"ls"}', status: "ok", durationMs: 5 }] },
  });
  const views = toolViews(state.messages[0].tools);
  assert.deepEqual(outcomes(views), [
    ["Run command", "complete", undefined],
    ["Run code", "failed", "Error: boom"],
  ]);
  assert.equal(views.filter((view) => view.status === "failed").length, 1, "the group counts one failure");
  assert.equal(summarise(views), "Ran 1 command, ran code");
});

test("a stopped codemode script keeps its own stopped row", () => {
  const views = toolViews([
    call("codemode", { code: "x" }, {
      state: "cancelled",
      output: "Stopped by the owner",
      children: [call("host_read", { path: "a.txt" }, { state: "complete", output: "" })],
    }),
  ]);
  assert.deepEqual(outcomes(views), [
    ["Read file", "complete", ""],
    ["Run code", "cancelled", "Stopped by the owner"],
  ]);
});

test("a successful codemode script is still listed only as its nested calls", () => {
  const state = codemodeSnapshot({
    content: "done",
    details: { calls: [{ id: 1, name: "host_read", args: '{"path":"a.txt"}', status: "ok" }] },
  });
  assert.deepEqual(outcomes(toolViews(state.messages[0].tools)), [["Read file", "complete", undefined]]);
});

test("a failed edit shows its error, not the diff it tried", () => {
  const [edit] = toolViews([
    call("edit", { path: "a.ts", oldText: "foo", newText: "bar" }, {
      output: "Could not find the exact text in a.ts",
      failed: true,
      state: "failed",
    }),
  ]);
  assert.equal(edit.kind, "edit");
  assert.equal(edit.status, "failed");
  assert.deepEqual(edit.files, [], "no diff for a change that never happened");
  assert.equal(edit.output, "Could not find the exact text in a.ts");
  assert.equal(edit.detail, "a.ts", "the row still names the file");
});

test("a failed or stopped write lists no file either, while running and finished edits keep their diff", () => {
  const [write] = toolViews([call("write", { path: "b.ts", content: "x" }, { output: "EACCES", failed: true, state: "failed" })]);
  assert.deepEqual([write.status, write.files, write.detail], ["failed", [], "b.ts"]);
  const [stopped] = toolViews([call("edit", { path: "a.ts", oldText: "foo", newText: "bar" }, { state: "cancelled" })]);
  assert.deepEqual(stopped.files, []);
  const [running] = toolViews([call("edit", { path: "a.ts", oldText: "foo", newText: "bar" }, { state: "running" })]);
  assert.equal(running.files.length, 1);
  const [done] = toolViews([call("edit", { path: "a.ts", oldText: "foo", newText: "bar" }, { state: "complete", output: "ok" })]);
  assert.deepEqual(done.files[0].lines, [
    { type: "remove", content: "foo" },
    { type: "add", content: "bar" },
  ]);
});
