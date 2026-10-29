import assert from "node:assert/strict";
import test from "node:test";
import { knownArchive, mergeArchive, parseArchive, subthreadActive } from "../lib/pi/archive.ts";
import { parseCompaction, readExtras } from "../lib/pi/host-extras.ts";

const chat = (id, title, extra = {}) => ({ id, title, modelId: "", provider: "", running: false, sideChats: [], sideChatTotal: 0, group: "", archived: false, pinned: false, channel: "", ...extra });

test("parseArchive keeps well-formed rows and a sane total", () => {
  assert.deepEqual(parseArchive({ items: [{ id: "4", title: "Side", kind: "side", parentId: "1", parentTitle: "Main" }, { id: "x", kind: "side" }, { id: "5", kind: "other" }], total: 9 }), {
    items: [{ id: "4", title: "Side", kind: "side", parentId: "1", parentTitle: "Main" }],
    total: 9,
  });
  assert.deepEqual(parseArchive({ conversations: [] }), { items: [], total: 0 });
  assert.deepEqual(parseArchive({ items: [{ id: "4", kind: "chat" }], total: 0 }).total, 1);
});

test("knownArchive: archived chats, finished side chats and sub-threads; the open one stays under its parent", () => {
  const known = knownArchive({
    conversations: [chat("1", "Main", { sideChats: [{ id: "8", title: "Busy", running: true }, { id: "9", title: "Done side", running: false }, { id: "10", title: "Open side", running: false }] }), chat("2", "Old", { archived: true })],
    subthreads: [{ id: "20", conversationId: "1", title: "Working", status: "running", modelId: "", provider: "", archived: false }, { id: "21", conversationId: "1", title: "Finished", status: "completed", modelId: "", provider: "", archived: false }],
    openId: "10",
  });
  assert.deepEqual([...known].filter(([, row]) => row).map(([id, row]) => [id, row.kind, row.parentTitle]), [["9", "side", "Main"], ["2", "chat", ""], ["21", "task", "Main"]]);
  assert.equal(known.get("1"), null);
  assert.equal(known.get("8"), null);
  assert.equal(known.get("10"), null);
  assert.equal(subthreadActive("running"), true);
  assert.equal(subthreadActive("completed"), false);
});

test("mergeArchive: recent moves on top, the page's knowledge wins, the host's order otherwise", () => {
  const known = knownArchive({ conversations: [chat("1", "Main", { sideChats: [{ id: "9", title: "Just finished", running: false }, { id: "8", title: "Running again", running: true }] }), chat("2", "Unarchived")], subthreads: [], openId: "" });
  const host = [
    { id: "8", title: "Running again", kind: "side", parentId: "1", parentTitle: "Main" },
    { id: "2", title: "Unarchived", kind: "chat", parentId: "", parentTitle: "" },
    { id: "30", title: "Older side", kind: "side", parentId: "3", parentTitle: "Other" },
  ];
  assert.deepEqual(mergeArchive({ host, known, openId: "", recent: ["9"] }).map((row) => row.id), ["9", "30"]);
  assert.deepEqual(mergeArchive({ host, known, openId: "", recent: [] }).map((row) => row.id), ["30"], "a known finished row not yet in the host list waits for it unless it just moved");
  assert.deepEqual(mergeArchive({ host: null, known, openId: "" }).map((row) => row.id), ["9"], "an older host: every row the page knows");
  assert.deepEqual(mergeArchive({ host, known, openId: "30" }).map((row) => row.id), [], "the open side chat shows under its parent");
});

test("host extras: compaction and the Duet switch", () => {
  assert.deepEqual(parseCompaction({ running: true, retryError: "busy", failure: 3 }), { running: true, retryError: "busy", failure: "" });
  assert.deepEqual(parseCompaction(undefined), { running: false, retryError: "", failure: "" });
  const extras = readExtras({ conversationId: "1", duet: true, compaction: { running: true } });
  assert.equal(extras.duet, true);
  assert.equal(extras.compaction.running, true);
  assert.equal(readExtras({ conversationId: "1" }).duet, false, "parked unless the host says so");
});
