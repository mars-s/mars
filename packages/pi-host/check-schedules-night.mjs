// Schedules (docs/SCHEDULES.md), two recovery and overlap cases on a real Harness over SQLite
// with a scripted fake model and an injected clock:
// - a run still going is never trimmed from the run history, so twenty and more skipped
//   occurrences cannot let a second run through (or make "Run now" available);
// - a task recovered at its "send" checkpoint after the owner paused the schedule or changed
//   its timing (a crash before the old task was aborted) does not send the prompt.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSchedules, SchedulesDoc } from './schedules.mjs';

const TZ = 'Australia/Sydney';
const MIN = 60000;
const passed = [];
const ok = (label) => passed.push(label);

const directory = await mkdtemp(join(tmpdir(), 'mars-schedules-night-'));
let clock = Date.parse('2026-03-01T21:58:00Z');
const calls = [];
let hold = false;
const held = new Set();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const models = {
  getModels: () => ['gpt-6-luna'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 2000, reasoning: true })),
  getModel(provider, id) { return this.getModels().find((model) => model.provider === provider && model.id === id); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const user = input.messages.findLast((message) => message.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : user?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    calls.push(prompt);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      held.delete(finish);
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Answer to ' + prompt }], api: 'fake', provider: model.provider, model: model.id, stopReason: options.signal?.aborted ? 'aborted' : 'stop', timestamp: Date.now(), usage };
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    };
    if (hold) held.add(finish); else queueMicrotask(finish);
    options.signal?.addEventListener('abort', finish, { once: true });
    return stream;
  },
};
const release = () => { for (const finish of [...held]) finish(); };

let harness, root, schedules;
/** `stallSend` stands in for a crash between the "send" checkpoint and the submit. */
async function open({ stallSend = false } = {}) {
  const registry = createRegistry();
  schedules = createSchedules({
    harness: () => harness, rootId: () => root.id, context, models,
    defaults: async () => ({}),
    defaultAgent: () => ({ model: { provider: 'openai', modelId: 'gpt-6-luna' } }),
    checkConversation: async () => {},
    now: () => clock, stepMs: 15, timezone: TZ,
  });
  let extension = schedules.extension;
  if (stallSend) {
    const definition = extension.tasks[0].definition;
    const send = (_current, runtime) => new Promise((_resolve, reject) => {
      const stop = () => reject(runtime.signal.reason ?? Error('closed'));
      if (runtime.signal.aborted) stop(); else runtime.signal.addEventListener('abort', stop, { once: true });
    });
    extension = { ...extension, tasks: [{ definition: { ...definition, phases: { ...definition.phases, send } } }] };
  }
  registry.install(extension);
  harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'agent.sqlite')), { models, registry, now: () => clock, settings: { retry: { maxRetries: 0 } } }, context);
  root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' } } });
  await schedules.boot();
  harness.resume();
}
async function close() { await harness.close(context); harness = undefined; }
async function until(check, message, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw Error('Timed out: ' + message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (id) => (await schedules.list()).schedules.find((s) => s.id === id);
const stored = async (id) => (await harness.snapshot(SchedulesDoc, context)).schedules[id];
const task = (id) => harness.getTask(id, context);
const promptCalls = (prompt) => calls.filter((call) => call === prompt).length;

try {
  // ---- A run still going survives any number of skipped occurrences ----------------------
  await open();
  hold = true;
  const PROMPT = 'Watch the long build.';
  const busy = await schedules.create({ title: 'Long build', prompt: PROMPT, when: { kind: 'interval', every: 5, unit: 'minutes' } });
  clock = busy.nextRunAt;
  await until(() => promptCalls(PROMPT) === 1, 'the first run reaches the model');
  const first = await until(async () => { const s = await get(busy.id); return s.lastRun?.status === 'running' && s.lastRun; }, 'the first run is running');
  // 21 skips: the old code trimmed the running record after 20, then sent the 22nd occurrence.
  for (let i = 0; i < 25; i++) {
    const due = (await stored(busy.id)).nextRunAt;
    clock = due;
    const s = await until(async () => { const row = await get(busy.id); return row.lastRun?.due === due && row; }, 'occurrence ' + (i + 2) + ' is recorded');
    assert.equal(s.lastRun.status, 'skipped', 'occurrence ' + (i + 2) + ' is skipped while the first run is going');
  }
  await pause(60);
  assert.equal(promptCalls(PROMPT), 1, 'no second run while the first is still going');
  const view = await get(busy.id);
  assert.equal(view.runs.length, 21, 'the last 20 runs plus the older one still going');
  assert.equal(view.runs.at(-1).key, first.key);
  assert.equal(view.runs.at(-1).status, 'running');
  await assert.rejects(schedules.runNow({ id: busy.id }), (error) => error.status === 409, 'run now is still refused');
  hold = false;
  release();
  const settledFirst = await until(async () => { const s = await get(busy.id); const row = s.runs.find((run) => run.key === first.key); return row?.status === 'completed' && s; }, 'the first run completes');
  assert.equal(settledFirst.runs.filter((run) => run.status === 'skipped').length, 20);
  await schedules.remove({ id: busy.id });
  ok('a run still going stays in the history past 20 skipped occurrences, so overlap protection and the run now refusal hold');

  // ---- A recovered "send" after pause or a timing change does not send --------------------
  const paused = await schedules.create({ title: 'Paused probe', prompt: 'Paused prompt.', when: { kind: 'interval', every: 5, unit: 'minutes' } });
  const moved = await schedules.create({ title: 'Moved probe', prompt: 'Moved prompt.', when: { kind: 'interval', every: 5, unit: 'minutes' } });
  await close();
  await open({ stallSend: true });
  const oldPaused = (await stored(paused.id)).taskId;
  const oldMoved = (await stored(moved.id)).taskId;
  clock = paused.nextRunAt;
  await until(async () => (await task(oldPaused))?.state.checkpoint?.phase === 'send' && (await task(oldMoved))?.state.checkpoint?.phase === 'send', 'both tasks reach their send checkpoint');
  // The update commits (pause; new timing with its task still to start), then Mars stops before
  // the old tasks are aborted.
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulesDoc);
    Object.assign(doc.schedules[paused.id], { enabled: false, taskId: null, nextRunAt: null, updatedAt: clock });
    Object.assign(doc.schedules[moved.id], { when: { kind: 'daily', time: '07:15' }, anchor: clock, taskId: null, nextRunAt: null, updatedAt: clock });
  }, context);
  await close();
  await open();
  await until(async () => (await task(oldPaused))?.state.status === 'terminal' && (await task(oldMoved))?.state.status === 'terminal', 'the old tasks end after recovery');
  await pause(60);
  assert.equal(promptCalls('Paused prompt.'), 0, 'a paused schedule does not send after a restart');
  assert.equal(promptCalls('Moved prompt.'), 0, 'a replaced task does not send after a restart');
  const pausedView = await get(paused.id);
  assert.equal(pausedView.enabled, false);
  assert.equal(pausedView.lastRun.status, 'failed');
  assert.match(pausedView.lastRun.reason, /paused or changed/);
  const movedView = await get(moved.id);
  assert.equal(movedView.lastRun.status, 'failed', 'the unsent run is not left starting');
  assert.notEqual((await stored(moved.id)).taskId, oldMoved, 'the new timing has its own task');
  assert.equal((await task((await stored(moved.id)).taskId))?.state.status, 'running');
  assert.equal(movedView.summary, 'Every day at 07:15 (Australia/Sydney)');
  ok('a task recovered at "send" after the schedule was paused or its timing changed ends without sending');

  await close();
  console.log('PASS schedules night: ' + passed.length + ' checks\n- ' + passed.join('\n- '));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (harness) await harness.close(context).catch(() => {});
} finally {
  await rm(directory, { recursive: true, force: true });
}
