import assert from "node:assert/strict";
import test from "node:test";
import { initialState, parseState, reduce, serialiseState, MIN_WIDTH } from "../components/workbench/workbench-state.ts";

test("starts closed with one launcher tab", () => {
  const state = initialState();
  assert.equal(state.open, false);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].kind, "launcher");
  assert.equal(state.activeId, state.tabs[0].id);
});

test("opening a tool replaces the launcher it was opened from, and reopening selects it", () => {
  let state = reduce(initialState(), { type: "open" });
  const launcherId = state.activeId;
  state = reduce(state, { type: "open-tool", target: { kind: "files", path: "notes" }, replace: launcherId });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].kind, "files");
  const filesId = state.activeId;
  state = reduce(state, { type: "new-tab" });
  assert.equal(state.tabs.length, 2);
  state = reduce(state, { type: "open-tool", target: { kind: "files", path: "notes" } });
  assert.equal(state.activeId, filesId, "same target selects the existing tab");
  assert.equal(state.tabs.length, 2);
});

test("closing the active tab selects its neighbour; closing the last resets to a launcher", () => {
  let state = reduce(initialState(), { type: "open" });
  state = reduce(state, { type: "open-tool", target: { kind: "terminal" } });
  state = reduce(state, { type: "open-tool", target: { kind: "page", name: "plan" } });
  const [a, b, c] = state.tabs.map((tab) => tab.id);
  state = reduce(state, { type: "close-tab", id: c });
  assert.equal(state.activeId, b);
  state = reduce(state, { type: "close-tab", id: a });
  state = reduce(state, { type: "close-tab", id: b });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].kind, "launcher");
});

test("width is clamped and close keeps tabs for the next open", () => {
  let state = reduce(initialState(), { type: "resize", width: 10 });
  assert.equal(state.width, MIN_WIDTH);
  state = reduce(state, { type: "open-tool", target: { kind: "browser", url: "http://127.0.0.1:3100/" } });
  state = reduce(state, { type: "close" });
  assert.equal(state.open, false);
  state = reduce(state, { type: "open" });
  assert.equal(state.tabs.at(-1).kind, "browser");
});

test("update patches a tab's target but never its id or kind", () => {
  let state = reduce(initialState(), { type: "open-tool", target: { kind: "terminal" } });
  const id = state.activeId;
  state = reduce(state, { type: "update", id, patch: { sessionId: "s1", kind: "files" } });
  const tab = state.tabs.find((item) => item.id === id);
  assert.equal(tab.kind, "terminal");
  assert.equal(tab.sessionId, "s1");
});

test("persisted state round-trips and rejects malformed or unsafe tabs", () => {
  let state = reduce(initialState(), { type: "open-tool", target: { kind: "extension", hash: "a".repeat(64), title: "Canvas" } });
  const restored = parseState(serialiseState(state));
  assert.deepEqual(restored.tabs.map((tab) => tab.kind), state.tabs.map((tab) => tab.kind));
  assert.equal(restored.activeId, state.activeId);
  const bad = parseState(JSON.stringify({ open: true, tabs: [{ id: "x", kind: "extension", hash: "../evil" }, { id: "y", kind: "nope" }] }));
  assert.equal(bad.tabs.length, 1);
  assert.equal(bad.tabs[0].kind, "launcher");
  assert.equal(parseState("{not json").open, false);
});

test("hydrate replaces the whole state", () => {
  const saved = reduce(initialState(), { type: "open-tool", target: { kind: "page", name: "plan" } });
  const next = reduce(initialState(), { type: "hydrate", state: saved });
  assert.equal(next, saved);
});
