import assert from "node:assert/strict";
import test from "node:test";
import { cachedState, fetchState, forgetStates, loadSavedState, rememberState } from "../lib/pi/state-cache.ts";

test("memory keeps the twelve most recent chats", () => {
  forgetStates();
  for (let i = 0; i < 14; i++) rememberState(String(i), { id: i }, "e" + i);
  assert.equal(cachedState("0"), undefined);
  assert.equal(cachedState("1"), undefined);
  assert.deepEqual(cachedState("13")?.value, { id: 13 });
  assert.equal(cachedState("13")?.etag, "e13");
});

test("fetchState sends the ETag and reads 304 as unchanged", async () => {
  const seen = [];
  globalThis.fetch = async (path, options) => {
    seen.push({ path, tag: options?.headers?.["if-none-match"] });
    if (options?.headers?.["if-none-match"] === '"a"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ conversationId: "7" }), { status: 200, headers: { etag: '"a"', "content-type": "application/json" } });
  };
  const first = await fetchState("7");
  assert.deepEqual(first, { unchanged: false, value: { conversationId: "7" }, etag: '"a"' });
  assert.deepEqual(await fetchState("7", '"a"'), { unchanged: true });
  assert.deepEqual(seen, [{ path: "/api/state?conversationId=7", tag: undefined }, { path: "/api/state?conversationId=7", tag: '"a"' }]);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404 });
  await assert.rejects(fetchState("9"), /Conversation not found/);
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  await assert.rejects(fetchState("9"), /session has expired/);
});

test("without IndexedDB, nothing is saved and nothing breaks", async () => {
  assert.equal(await loadSavedState("7"), undefined);
});
