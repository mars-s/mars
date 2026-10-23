// Duet on a real Pi harness with a scripted, gated model (no provider is called): the thread,
// tasks running in parallel, results posted per task while others still run, the owner's reply
// steering one task, stop, the task pool, mail between tasks, the board's compare-and-set and
// claims, replay without duplicates, refusals outside Duet, and the chat tools.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DuetThreadDoc, createDuet, createDuetExtension } from './duet.mjs';
import { ProjectDoc } from './project.mjs';

const seen = [];
const prompts = [];
const gates = new Map();
const gate = (name) => {
  if (!gates.has(name)) { let release; const promise = new Promise((resolve) => { release = resolve; }); gates.set(name, { promise, release }); }
  return gates.get(name);
};
const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
let calls = 0;
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    calls++;
    const last = input.messages.filter((m) => m.role !== 'system').at(-1);
    const text = last?.role === 'user' ? textOf(last) : '';
    prompts.push(input.messages.filter((m) => m.role === 'system').map((m) => Object.values(m.sections ?? {}).join('\n')).join('\n'));
    seen.push({ text, all: input.messages.filter((m) => m.role === 'user').map(textOf) });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const line = (/(?:^|\n|\]: )((?:CALL|WAIT|SAY) [^\n]*)/.exec(text) || [])[1] || '';
    let wait = Promise.resolve();
    if (line.startsWith('CALL ')) {
      const [, name, ...json] = line.split(' ');
      message.content = [{ type: 'toolCall', id: 'call-' + calls, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    } else if (line.startsWith('WAIT ')) {
      const name = line.slice(5).trim();
      wait = gate(name).promise;
      message.content = [{ type: 'text', text: 'answer ' + name }];
    } else if (line.startsWith('SAY ')) message.content = [{ type: 'text', text: line.slice(4) }];
    else if (last?.role === 'toolResult') message.content = [{ type: 'text', text: 'tool said ' + textOf(last).slice(0, 300) }];
    const finish = () => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); };
    const aborted = () => { const m = { ...message, content: [], stopReason: 'aborted' }; stream.push({ type: 'error', reason: 'aborted', error: m }); stream.end(m); };
    options?.signal?.addEventListener?.('abort', aborted, { once: true });
    void wait.then(() => setTimeout(() => { if (!options?.signal?.aborted) finish(); }, 5));
    return stream;
  },
};

const late = {};
const opened = [];
const duet = createDuet({
  harness: () => late.harness,
  models,
  defaultAgent: () => ({ model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: late.tools }),
  context,
  openProject: async (id, path) => { opened.push([id, path]); await late.harness.commit(async (tx) => { (await tx.doc(ProjectDoc, Number(id))).root = path; }, context); return { root: path }; },
});
const extension = createDuetExtension({ duet });
late.tools = extension.tools;
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-duet-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
late.harness = harness;
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: extension.tools } });

const until = async (what, check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const lastToolResult = async (conversationId) => {
  const view = await (await harness.conversation(Number(conversationId), context)).viewState(context);
  try {
    const result = view.value.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === 'toolResult').at(-1);
    return { error: result?.isError === true, value: (() => { try { return JSON.parse(textOf(result)); } catch { return textOf(result); } })() };
  } finally { view.dispose(); }
};
const idle = (id) => until('conversation ' + id + ' idle', async () => !(await harness.snapshot(LiveDoc, Number(id), context))?.run);
const front = async (text) => {
  const sent = await duet.message({ text });
  await idle(sent.threadId);
  return lastToolResult(sent.threadId);
};
const task = async (id) => (await duet.tasks(await duet.threadId())).find((row) => row.id === id);
const results = async () => (await duet.view()).messages.filter((m) => m.from === 'duet' && m.kind === 'result');

try {
  // The thread is made once.
  const thread = await duet.ensureThread();
  assert.equal(await duet.ensureThread(), thread, 'one Duet thread');
  assert.equal((await harness.snapshot(DuetThreadDoc, Number(thread), context)).isThread, true);

  // Task A starts and keeps running (gated). Task B starts while A runs and finishes first.
  const a = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Hotels', brief: 'WAIT hotels', model: 'sol', origin: 'find me a hotel' }));
  assert.equal(a.error, false, JSON.stringify(a.value));
  assert.equal(a.value.taskId, 'T1');
  assert.equal(a.value.state, 'running');
  assert.ok(prompts.some((p) => p.includes('Duet front desk')), 'the thread gets the front desk section');
  const b = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Flights', brief: 'SAY Friday flight QF25 at 9am', origin: 'find a flight' }));
  assert.equal(b.value.taskId, 'T2');
  await until('B result', async () => (await results()).some((m) => m.taskId === 'T2'));
  const flight = (await results()).find((m) => m.taskId === 'T2');
  assert.equal(flight.text, 'Friday flight QF25 at 9am');
  assert.equal(flight.label, 'Flights');
  assert.equal(flight.quote, 'find a flight');
  assert.equal((await task('T1')).state, 'running', 'A still runs after B reported');
  assert.equal((await task('T2')).state, 'done');
  assert.ok(prompts.some((p) => p.includes('Duet task T2 "Flights"')), 'a task gets the task section');

  // The owner replies to A directly: it reaches A only, and shows as the owner's bubble with A's label.
  const steered = await duet.message({ text: 'SAY only refundable ones', taskId: 'T1' });
  assert.equal(steered.taskId, 'T1');
  gate('hotels').release();
  await until('A result', async () => (await results()).some((m) => m.taskId === 'T1' && m.text === 'answer hotels'));
  await until('A answers the steer', async () => (await results()).some((m) => m.taskId === 'T1' && m.text === 'only refundable ones'));
  assert.ok(!seen.some((row) => row.all.some((t) => t.includes('only refundable')) && row.all.some((t) => t.includes('Friday flight'))), 'the steer never reached B');
  const view = await duet.view();
  assert.ok(view.messages.some((m) => m.from === 'owner' && m.taskId === 'T1' && m.text === 'SAY only refundable ones'));
  assert.ok(view.messages.some((m) => m.from === 'system' && m.kind === 'started' && m.taskId === 'T1'));
  assert.ok(view.messages.some((m) => m.from === 'owner' && !m.taskId && m.text.startsWith('CALL duet_task_start')), 'front desk messages show as the owner\'s');

  // Stop: a gated task stops, says so, and nothing else changes.
  const c = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Slow', brief: 'WAIT slow' }));
  await until('C running', async () => (await harness.snapshot(LiveDoc, Number(c.value.conversationId), context))?.run);
  const stopped = await front('CALL duet_task_stop ' + JSON.stringify({ taskId: 'Slow' }));
  assert.equal(stopped.value.state, 'stopped');
  assert.equal((await task('T3')).state, 'stopped');
  assert.ok((await duet.view()).messages.some((m) => m.kind === 'stopped' && m.taskId === 'T3'));
  gate('slow').release();

  // The pool: with room for one, the second task waits, then starts when the first finishes.
  await harness.commit(async (tx) => { (await tx.doc(DuetThreadDoc, Number(thread))).maxActive = 1; }, context);
  const d = await front('CALL duet_task_start ' + JSON.stringify({ label: 'One', brief: 'WAIT one' }));
  const e = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Two', brief: 'SAY two done' }));
  assert.equal(d.value.state, 'running');
  assert.equal(e.value.state, 'queued', 'a full pool queues the task');
  const queuedSteer = await duet.message({ text: 'use the cheap one', taskId: 'Two' });
  assert.match(queuedSteer.delivered, /brief/);
  gate('one').release();
  await until('queued task ran', async () => (await results()).some((m) => m.taskId === 'T5' && m.text === 'two done'));
  assert.ok(seen.some((row) => row.text.includes('use the cheap one') && row.text.includes('SAY two done')), 'the queued steer joined the brief');
  await harness.commit(async (tx) => { (await tx.doc(DuetThreadDoc, Number(thread))).maxActive = 6; }, context);

  // Mail: a task asks another; the answer goes back; the thread shows a system line.
  const asker = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Asker', brief: 'CALL duet_mail ' + JSON.stringify({ to: 'T2', purpose: 'question', text: 'SAY landing 14:05' }) }));
  await until('mail delivered', async () => (await results()).some((m) => m.taskId === 'T2' && m.text === 'landing 14:05'));
  const mailLine = (await duet.view()).messages.find((m) => m.kind === 'mail');
  assert.ok(mailLine && mailLine.text.startsWith('Asker to Flights'), JSON.stringify(mailLine));
  assert.ok(seen.some((row) => row.text.startsWith('[Mail ') && row.text.includes('from task ' + asker.value.taskId)), 'the mail is labelled as mail, not as the owner');
  await until('asker done', async () => (await task(asker.value.taskId)).state === 'done');
  const self = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Self', brief: 'CALL duet_mail ' + JSON.stringify({ to: 'T7', text: 'hi' }) }));
  await until('self mail refused', async () => (await results()).some((m) => m.taskId === self.value.taskId && /cannot mail itself/.test(m.text)));

  // The board: compare-and-set and claims, written by two tasks.
  const first = await duet.writeBoard({ thread, by: 'T1', key: 'arrival', value: '14:05', ifVersion: 0 });
  assert.deepEqual(first, { ok: true, version: 1 });
  const stale = await duet.writeBoard({ thread, by: 'T2', key: 'arrival', value: '15:00', ifVersion: 0 });
  assert.equal(stale.ok, false, 'a stale version is refused');
  assert.equal((await duet.writeBoard({ thread, by: 'T1', key: 'calendar:fri', claimSeconds: 60 })).ok, true);
  const taken = await duet.writeBoard({ thread, by: 'T2', key: 'calendar:fri', claimSeconds: 60 });
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /claimed by T1/);
  const board = await duet.boardOf(thread);
  assert.equal(board.facts.arrival.value, '14:05');
  assert.equal(board.facts.arrival.by, 'T1');
  const boardTask = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Board', brief: 'CALL duet_board_write ' + JSON.stringify({ key: 'calendar:fri', claimSeconds: 30 }) }));
  await until('board tool result', async () => (await results()).some((m) => m.taskId === boardTask.value.taskId && m.text.includes('claimed by T1')));

  // Replay: the same request key gives the same task, not a second one.
  const before = (await duet.tasks(thread)).length;
  const once = await duet.startTask({ thread, label: 'Replay', brief: 'SAY replayed', requestKey: 'k1' });
  const twice = await duet.startTask({ thread, label: 'Replay', brief: 'SAY replayed', requestKey: 'k1' });
  assert.equal(once.taskId, twice.taskId);
  assert.equal((await duet.tasks(thread)).length, before + 1);

  // Refusals outside Duet: the root chat cannot start tasks; a non-task cannot post.
  await (await root.submit({ type: 'input', content: 'CALL duet_task_start ' + JSON.stringify({ label: 'X', brief: 'SAY x' }) }, context)).wait(context);
  const refused = await lastToolResult(root.id);
  assert.equal(refused.error, true);
  assert.match(JSON.stringify(refused.value), /Only the Duet thread/);
  await (await root.submit({ type: 'input', content: 'CALL duet_post ' + JSON.stringify({ text: 'hi' }) }, context)).wait(context);
  assert.match(JSON.stringify((await lastToolResult(root.id)).value), /Only a Duet task/);

  // Updates are rate limited; questions are not.
  const poster = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Poster', brief: 'CALL duet_post ' + JSON.stringify({ kind: 'update', text: 'halfway' }) }));
  await until('update posted', async () => (await duet.view()).messages.some((m) => m.kind === 'update' && m.text === 'halfway' && m.taskId === poster.value.taskId));
  const tooSoon = await duet.postFromTask({ conversationId: poster.value.conversationId, kind: 'update', text: 'again', requestId: 'r1' });
  assert.equal(tooSoon.posted, false);
  assert.equal((await duet.postFromTask({ conversationId: poster.value.conversationId, kind: 'question', text: 'which one?', requestId: 'r2' })).posted, true);

  // Chat tools from the front desk: make, list, read and message a chat in a project.
  const made = await front('CALL chat_create ' + JSON.stringify({ title: 'Fix sidebar', project: '/tmp/repo', message: 'SAY looking now' }));
  assert.equal(made.error, false, JSON.stringify(made.value));
  assert.deepEqual(opened, [[made.value.chatId, '/tmp/repo']]);
  await idle(made.value.chatId);
  const listed = await front('CALL chat_list ' + JSON.stringify({ query: 'sidebar' }));
  assert.deepEqual(listed.value.map((row) => row.chatId), [made.value.chatId]);
  const read = await front('CALL chat_read ' + JSON.stringify({ chatId: made.value.chatId }));
  assert.equal(read.value.answer, 'looking now');
  const sentTo = await front('CALL chat_send ' + JSON.stringify({ chatId: made.value.chatId, text: 'SAY fixed' }));
  assert.equal(sentTo.value.sent, true);
  await until('chat answered', async () => (await duet.readChat(made.value.chatId)).answer === 'fixed');

  // The HTTP view lists tasks with their states.
  const final = await duet.route('GET', '/api/duet');
  assert.equal(final.threadId, thread);
  assert.deepEqual(final.tasks.slice(0, 3).map((row) => [row.id, row.label]), [['T1', 'Hotels'], ['T2', 'Flights'], ['T3', 'Slow']]);
  console.log('PASS duet: one thread; tasks run in parallel and report one by one; owner replies steer one task; stop; pool queues and drains; mail between tasks; board compare-and-set and claims; replay makes no duplicate; refusals outside Duet; update limit; chat tools');
} catch (error) {
  console.error(error);
  if (process.env.DUET_DEBUG) { console.log(JSON.stringify(seen.filter((r) => r.all.some((t) => t.includes('refundable') || t.includes('hotels'))).map((r) => r.all), null, 1).slice(0, 3000)); console.log(JSON.stringify((await duet.view()).messages, null, 1).slice(0, 3000)); const t1 = (await duet.tasks(await duet.threadId()))[0]; const v = await (await harness.conversation(Number(t1.conversationId), context)).viewState(context); console.log(JSON.stringify(v.value.entries.map((e) => [e.kind, (e.model ?? []).map((m) => m.role + ':' + textOf(m).slice(0, 60))]))); console.log(JSON.stringify(v.value.docs?.['pi.inbox'])); v.dispose(); }
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
