// Duet as a personal assistant (docs/DUET.md "Assistant behaviour"), on a real Pi harness with
// the scripted model check-duet.mjs uses: the system prompt stays byte-stable while tasks change
// (they arrive as a [Duet now] note); the owner's message steers a running turn; events are
// de-duplicated, merged into one turn, and that turn's plain replies stay private; results of
// work nobody asked for are quiet; a grey-area confirm box holds a task until answered; "Not
// right" saves an eval case; journal, scratchpad, cache numbers and compaction after idle.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
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
const work = await mkdtemp(join(tmpdir(), 'mars-duet-work-'));
const duet = createDuet({
  harness: () => late.harness, work, mergeMs: 60, idleMs: 300, compactTokens: 1,
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

const passed = [];
const entriesOf = async (id) => {
  const view = await (await harness.conversation(Number(id), context)).viewState(context);
  try { return structuredClone(view.value.entries); } finally { view.dispose(); }
};
const deskPrompts = () => prompts.filter((p) => p.includes('Duet front desk'));
try {
  const thread = await duet.ensureThread();

  // A request is the approval; ask only in grey areas.
  await front('SAY hello');
  const prompt = deskPrompts().at(-1);
  assert.match(prompt, /A request is the approval/);
  assert.match(prompt, /duet_confirm/);
  assert.doesNotMatch(prompt, /Ask before sending messages/);
  passed.push('acts without asking');

  // The system prompt stays the same while tasks change; tasks come as a [Duet now] note.
  const before = deskPrompts().at(-1);
  const started = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Hotels', brief: 'WAIT hotels', model: 'sol', origin: 'find me a hotel' }));
  assert.equal(started.error, false, JSON.stringify(started.value));
  await front('SAY anything else');
  assert.equal(deskPrompts().at(-1), before, 'byte-stable system prompt');
  assert.ok(seen.at(-1).all.some((t) => t.startsWith('[Duet now]') && t.includes('T1 "Hotels"')), 'the tasks arrive as a note');
  const notes = (await entriesOf(thread)).filter((e) => e.kind === 'mars.duet-context').length;
  await front('SAY again');
  assert.equal((await entriesOf(thread)).filter((e) => e.kind === 'mars.duet-context').length, notes, 'no new note when nothing changed');
  passed.push('stable prompt, [Duet now] note');

  // The owner's message cuts into a running front desk turn (a steer), not behind it.
  const busy = await duet.message({ text: 'WAIT desk' });
  await until('desk running', async () => (await harness.snapshot(LiveDoc, Number(thread), context))?.run);
  await duet.message({ text: 'SAY and this' });
  const inbox = await until('steer queued', async () => {
    const v = await (await harness.conversation(Number(thread), context)).viewState(context);
    try { return (v.value.docs?.['pi.inbox']?.items ?? []).find((item) => JSON.stringify(item.content).includes('and this')); } finally { v.dispose(); }
  });
  assert.equal(inbox.mode, 'steer');
  gate('desk').release();
  await idle(busy.threadId);
  passed.push('owner interrupts');

  // Events: de-duplicated, merged into one turn, and that turn's plain reply stays private.
  const replies = async () => (await duet.view()).messages.filter((m) => m.from === 'duet' && m.kind === 'reply').length;
  const visible = await replies();
  const one = await duet.event({ text: 'Backup finished', source: 'nightly', dedupeKey: 'backup-1' });
  await duet.event({ text: 'Calendar moved the 3pm', source: 'calendar' });
  assert.equal((await duet.event({ text: 'Backup finished', source: 'nightly', dedupeKey: 'backup-1' })).duplicate, true);
  assert.equal(one.queued, true);
  await duet.settled();
  await idle(thread);
  const wakes = (await entriesOf(thread)).filter((e) => e.kind === 'mars.duet-wake');
  assert.equal(wakes.length, 1, 'two events, one turn');
  assert.equal(wakes[0].data.events.length, 2);
  assert.equal(await replies(), visible, 'the plain reply to events stays private');
  await duet.send({ thread, text: 'Your 3pm moved to 4pm.', requestId: 'send-1' });
  assert.ok((await duet.view()).messages.some((m) => m.from === 'duet' && m.text === 'Your 3pm moved to 4pm.'), 'duet_send reaches the owner');
  await front('SAY back to you');
  assert.equal(await replies(), visible + 2, 'the sent message and the reply to the owner both show');
  passed.push('event router, private replies, duet_send');

  // Work nobody asked for (no origin) is filed quietly; asked-for work is not.
  await front('CALL duet_task_start ' + JSON.stringify({ label: 'Tidy', brief: 'SAY tidied the downloads' }));
  await front('CALL duet_task_start ' + JSON.stringify({ label: 'Asked', brief: 'SAY here it is', origin: 'do it' }));
  const tidy = await until('tidy result', async () => (await duet.view()).messages.find((m) => m.kind === 'result' && m.label === 'Tidy'));
  const asked = await until('asked result', async () => (await duet.view()).messages.find((m) => m.kind === 'result' && m.label === 'Asked'));
  assert.equal(tidy.quiet, true);
  assert.equal(asked.quiet, undefined);
  passed.push('quiet results');

  // A grey-area confirm holds the task, then the answer runs it on.
  const asker = await front('CALL duet_task_start ' + JSON.stringify({ label: 'Email', origin: 'email sarah', brief: 'CALL duet_confirm ' + JSON.stringify({ question: 'Two Sarahs. Sarah Lee?', action: 'Send to Sarah Lee' }) }));
  const box = await until('confirm box', async () => (await duet.view()).messages.find((m) => m.kind === 'confirm'));
  assert.equal(box.confirm.state, 'pending');
  assert.equal(box.taskId, asker.value.taskId);
  await until('task waits', async () => (await task(asker.value.taskId))?.state === 'waiting');
  assert.equal((await duet.view()).messages.some((m) => m.kind === 'result' && m.label === 'Email'), false, 'no result while it waits');
  assert.equal((await duet.route('POST', '/api/duet/confirm', { confirmId: box.confirm.id, answer: 'yes' })).ok, true);
  await until('answer reached the task', async () => seen.some((row) => row.text.includes('The owner answered "Go ahead" to: Two Sarahs')));
  assert.equal((await duet.view()).messages.find((m) => m.kind === 'confirm').confirm.state, 'yes');
  assert.equal((await duet.route('POST', '/api/duet/confirm', { confirmId: box.confirm.id, answer: 'no' })).state, 'yes', 'answered once');
  passed.push('grey-area confirm');

  // "Not right" saves an eval case, marks the message and tells the front desk.
  const target = (await duet.view()).messages.find((m) => m.from === 'duet' && m.kind === 'result' && m.label === 'Asked');
  const saved = await duet.route('POST', '/api/duet/feedback', { messageId: target.id, note: 'wrong hotel' });
  assert.equal(saved.saved, true);
  const files = await readdir(join(work, 'duet', 'evals'));
  const record = JSON.parse(await readFile(join(work, 'duet', 'evals', files[0]), 'utf8'));
  assert.equal(record.message, 'here it is');
  assert.equal(record.note, 'wrong hotel');
  assert.equal((await duet.view()).messages.find((m) => m.id === target.id).feedback, 'wrong');
  await duet.settled();
  await until('feedback event', async () => (await entriesOf(thread)).some((e) => e.kind === 'mars.duet-wake' && JSON.stringify(e.data).includes('not right')));
  passed.push('not right to eval');

  // Journal and scratchpad.
  await duet.journal({ text: 'Booked the hotel' });
  const day = new Date().toISOString().slice(0, 10);
  assert.match(await readFile(join(work, 'duet', 'journal', day + '.md'), 'utf8'), /Booked the hotel/);
  await duet.scratch({ thread, text: 'Owner is boarding at 10:40' });
  await idle(thread);
  await front('SAY ok then');
  assert.ok(seen.at(-1).all.some((t) => t.startsWith('[Duet now]') && t.includes('boarding at 10:40')), 'the scratchpad rides in the note');
  passed.push('journal and scratchpad');

  // Cache numbers and compaction once the owner has been away.
  const stats = (await duet.view()).context;
  assert.equal(typeof stats.cacheHitPercent, 'number');
  assert.ok(stats.turns > 0);
  await duet.message({ text: 'SAY last' });
  await idle(thread);
  assert.equal(await duet.compactIfIdle(thread), false, 'not while the owner is around');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await duet.compactIfIdle(thread), true, 'compacts after the owner has been away');
  passed.push('cache numbers, idle compaction');
  console.log('PASS duet assistant: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  if (process.env.DUET_DEBUG) console.log(JSON.stringify((await duet.view()).messages.slice(-12), null, 1));
  process.exitCode = 1;
} finally {
  for (const g of gates.values()) g.release();
  await harness.close(context).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
