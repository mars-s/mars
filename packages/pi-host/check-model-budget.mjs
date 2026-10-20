import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createModels } from "@earendil-works/pi-ai/models";
import { installModelBudget } from "./model-budget.mjs";

const model = { api: "fixture", provider: "fixture", id: "fixture" };
const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text: "fixture" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() });
const turns = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const calls = [];
let active = 0;
let peak = 0;
const models = {
  marker: true,
  streamSimple(received, context, options) {
    assert.equal(this.marker, true, "original Models receiver is preserved");
    assert.equal(received, model);
    if (context.throw) throw Error("provider threw");
    active++;
    peak = Math.max(peak, active);
    const stream = createAssistantMessageEventStream();
    let settled = false;
    const finish = (error = false) => {
      if (settled) return;
      settled = true;
      active--;
      options.signal?.removeEventListener("abort", cancel);
      const result = message(error === "error" ? "error" : error ? "aborted" : "stop");
      stream.push(error ? { type: "error", reason: result.stopReason, error: result } : { type: "done", reason: "stop", message: result });
    };
    const cancel = () => finish(true);
    options.signal?.addEventListener("abort", cancel, { once: true });
    calls.push({ context, options, finish, stream });
    return stream;
  },
};
const budget = installModelBudget(models);
const results = [];
async function check(name, fn) { await fn(); results.push(name); }
await check("native factory is mutable and frozen instances reject clearly", async () => {
  const native = createModels();
  installModelBudget(native);
  assert.throws(() => installModelBudget(Object.freeze({ streamSimple() {} })), /cannot install/);
});
await check("synchronous native streams and global concurrency ceiling", async () => {
  const streams = Array.from({ length: 7 }, (_, index) => models.streamSimple(model, { index }));
  assert.equal(typeof streams[0].result, "function");
  assert.equal(typeof streams[0][Symbol.asyncIterator], "function");
  await turns();
  assert.deepEqual(budget.status(), { running: 4, waiting: 3, maxConcurrent: 4, maxOutputTokens: 8192 });
  calls.slice(0, 4).forEach((call) => call.finish());
  await turns();
  assert.equal(calls.length, 7);
  calls.slice(4).forEach((call) => call.finish());
  const received = await Promise.all(streams.map((stream) => stream.result()));
  await turns();
  assert.equal(peak, 4);
  assert.equal(received.length, 7);
  assert.ok(received.every((result) => result.usage === usage), "provider usage is unchanged");
  assert.ok(calls.every((call) => call.options.maxTokens === 8192));
  assert.equal(budget.status().running, 0);
});
await check("queued cancellation never dispatches and does not invent spend", async () => {
  const running = Array.from({ length: 4 }, () => models.streamSimple(model, {}));
  await turns();
  const start = calls.length;
  const controller = new AbortController();
  const queued = models.streamSimple(model, { cancelled: true }, { signal: controller.signal });
  controller.abort();
  const result = await queued.result();
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  calls.slice(-4).forEach((call) => call.finish());
  await Promise.all(running.map((stream) => stream.result()));
  await turns();
  assert.equal(calls.length, start);
  assert.equal(budget.status().waiting, 0);
});
await check("running abort forwards native signal and preserves one final usage result", async () => {
  const controller = new AbortController();
  const stream = models.streamSimple(model, {}, { signal: controller.signal, maxTokens: 3000 });
  await turns();
  assert.equal(calls.at(-1).options.signal, controller.signal);
  assert.equal(calls.at(-1).options.maxTokens, 3000);
  controller.abort();
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  await turns();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(result.usage, usage);
  assert.equal(budget.status().running, 0);
});
await check("native provider error releases slot and preserves error usage", async () => {
  const stream = models.streamSimple(model, {});
  await turns();
  calls.at(-1).finish("error");
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "error");
  assert.equal((await stream.result()).usage, usage);
  await turns();
  assert.equal(budget.status().running, 0);
});
await check("synchronous provider error releases slot and later requests dispatch", async () => {
  const failed = models.streamSimple(model, { throw: true });
  assert.equal((await failed.result()).errorMessage, "provider threw");
  await turns();
  assert.equal(budget.status().running, 0);
  const good = models.streamSimple(model, {}, { maxTokens: 100000 });
  await turns();
  assert.equal(calls.at(-1).options.maxTokens, 8192);
  calls.at(-1).finish();
  assert.equal((await good.result()).stopReason, "stop");
});
await check("host configuration overrides defaults and pre-abort never dispatches", async () => {
  let called = false;
  const configured = { streamSimple() { called = true; throw Error("unexpected"); } };
  const custom = installModelBudget(configured, { maxConcurrent: 2, maxOutputTokens: 16384 });
  const controller = new AbortController();
  controller.abort();
  const stream = configured.streamSimple(model, {}, { signal: controller.signal });
  assert.equal((await stream.result()).stopReason, "aborted");
  await turns();
  assert.equal(called, false);
  assert.deepEqual(custom.status(), { running: 0, waiting: 0, maxConcurrent: 2, maxOutputTokens: 16384 });
});
console.log(JSON.stringify({ status: "PASS", checks: results }, null, 2));
