import assert from "node:assert/strict";
import test from "node:test";
import { runSteps as steps } from "../components/ai/run-steps.ts";
import { toolViews } from "../components/ai/tool-adapter.ts";

const runSteps = (snapshot) => steps(snapshot, toolViews);

const base = { running: true, messages: [] };
const tool = (id, name, input, extra = {}) => ({ id, name, input: JSON.stringify(input), failed: false, ...extra });

test("no run means no loading steps", () => {
  assert.deepEqual(runSteps(null), []);
  assert.deepEqual(runSteps({ ...base, running: false, messages: [{ id: "a", role: "assistant", text: "x", tools: [], running: false }] }), []);
});

test("a run with no tools yet is a single Thinking step", () => {
  const steps = runSteps({ ...base, messages: [{ id: "u", role: "user", text: "hi", tools: [], running: false }] });
  assert.deepEqual(steps.map((step) => [step.label, step.status]), [["Thinking", "running"]]);
});

test("steps come from tools after the latest user message, with real statuses", () => {
  const steps = runSteps({
    ...base,
    messages: [
      { id: "old", role: "assistant", text: "", running: false, tools: [tool("t0", "bash", { command: "ls" }, { output: "x", state: "complete" })] },
      { id: "u", role: "user", text: "go", tools: [], running: false },
      {
        id: "a1",
        role: "assistant",
        text: "",
        running: false,
        tools: [
          tool("t1", "bash", { command: "npm test" }, { output: "fail", failed: true, state: "failed" }),
          tool("t2", "read", { path: "a.md" }, { state: "running" }),
        ],
      },
      { id: "live", role: "assistant", text: "", running: true, tools: [] },
    ],
  });
  assert.deepEqual(
    steps.map((step) => step.status),
    ["error", "running"],
    "old turn excluded, failed shown as error, running tool means no extra model step",
  );
  assert.match(steps[1].label, /a\.md/);
});

test("streaming text turns the model step into Writing the reply", () => {
  const steps = runSteps({
    ...base,
    messages: [
      { id: "u", role: "user", text: "go", tools: [], running: false },
      { id: "live", role: "assistant", text: "Here is", running: true, tools: [] },
    ],
  });
  assert.equal(steps.at(-1).label, "Writing the reply");
});
