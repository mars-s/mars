// Duet parsing (docs/DUET.md): quiet results, confirm questions, Not right feedback and the cache
// figure, read defensively so a host from before them still gives a usable thread.
import assert from "node:assert/strict";
import test from "node:test";
import { cacheLabel, cacheTitle, canMarkWrong, groupQuiet, parseDuet, quietSummary } from "../lib/pi/duet.ts";

const bubble = (id, extra = {}) => ({ id, from: "duet", kind: "result", text: "Result " + id, taskId: "T1", label: "Hotels", quote: "", ...extra });

test("an older host's messages get the new fields switched off", () => {
  const view = parseDuet({ threadId: "50", messages: [bubble("1")], tasks: [] });
  assert.deepEqual(
    { quiet: view.messages[0].quiet, feedback: view.messages[0].feedback, confirm: view.messages[0].confirm },
    { quiet: false, feedback: "", confirm: null },
  );
  assert.equal(view.context, null);
  assert.equal(cacheLabel(view.context), "");
  assert.equal(cacheTitle(view.context), "");
});

test("quiet, feedback and confirm are read only in their exact shapes", () => {
  const view = parseDuet({
    messages: [
      bubble("1", { quiet: true, feedback: "wrong" }),
      bubble("2", { quiet: "yes", feedback: "bad" }),
      bubble("3", { kind: "confirm", confirm: { id: "C1", state: "pending", action: "Book the Park Hyatt, $420" } }),
      bubble("4", { kind: "confirm", confirm: { id: "C2", state: "maybe", action: 7 } }),
      bubble("5", { kind: "confirm", confirm: { state: "yes" } }),
    ],
  });
  const [one, two, three, four, five] = view.messages;
  assert.equal(one.quiet, true);
  assert.equal(one.feedback, "wrong");
  assert.equal(two.quiet, false);
  assert.equal(two.feedback, "");
  assert.deepEqual(three.confirm, { id: "C1", state: "pending", action: "Book the Park Hyatt, $420" });
  assert.deepEqual(four.confirm, { id: "C2", state: "pending", action: "" }, "an unknown state still asks");
  assert.equal(five.confirm, null, "a confirm without an id cannot be answered");
});

test("the cache figure shows as a whole percentage with a plain tooltip", () => {
  const view = parseDuet({ context: { cacheHitPercent: 91.4, cachedTokens: 109200, inputTokens: 120000, turns: 14 } });
  assert.deepEqual(view.context, { cacheHitPercent: 91.4, cachedTokens: 109200, inputTokens: 120000, turns: 14 });
  assert.equal(cacheLabel(view.context), "Cache 91%");
  assert.match(cacheTitle(view.context), /model provider reused/);
  assert.match(cacheTitle(view.context), /109,200 of 120,000 input tokens over 14 turns/);
  assert.equal(cacheLabel(parseDuet({ context: { cacheHitPercent: null, turns: 0 } }).context), "", "no figure yet");
  assert.equal(cacheLabel(parseDuet({ context: { cacheHitPercent: "91" } }).context), "");
  assert.equal(cacheLabel(parseDuet({ context: { cacheHitPercent: 140 } }).context), "Cache 100%");
  assert.deepEqual(parseDuet({ context: { cacheHitPercent: 5, cachedTokens: -1, inputTokens: 1.5 } }).context, { cacheHitPercent: 5, cachedTokens: 0, inputTokens: 0, turns: 0 });
});

test("consecutive quiet bubbles fold into one item, others stay as they are", () => {
  const { messages } = parseDuet({
    messages: [bubble("1"), bubble("2", { quiet: true }), bubble("3", { quiet: true, label: "Flights" }), bubble("4", { quiet: true }), bubble("5"), bubble("6", { quiet: true })],
  });
  const items = groupQuiet(messages);
  assert.deepEqual(
    items.map((item) => (item.kind === "quiet" ? item.messages.map((m) => m.id) : item.message.id)),
    ["1", ["2", "3", "4"], "5", ["6"]],
  );
  assert.equal(items[1].id, "quiet-2", "the fold keeps a stable id while more join it");
  assert.equal(quietSummary(items[1].messages), "3 quiet updates");
  assert.equal(quietSummary(items[3].messages), "1 quiet update");
});

test("only Duet's own replies and results can be marked Not right", () => {
  const can = (extra) => canMarkWrong(parseDuet({ messages: [bubble("1", extra)] }).messages[0]);
  assert.equal(can({ kind: "reply", taskId: "" }), true);
  assert.equal(can({ kind: "result" }), true);
  assert.equal(can({ kind: "question" }), false);
  assert.equal(can({ kind: "confirm" }), false);
  assert.equal(can({ from: "owner", kind: "message" }), false);
});
