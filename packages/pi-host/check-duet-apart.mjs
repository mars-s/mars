// Duet is not a chat (docs/DUET.md): the chat list leaves the Duet thread out (and with it its
// tasks), GET /api/duet/thread names it, and typing dots show only for the owner's turns, not
// for event turns whose replies are private. Real Pi harness, scripted model as check-duet.mjs.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
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
  harness: () => late.harness, mergeMs: 30,
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
try {
  const thread = await duet.ensureThread();
  const conversations = createConversationManager({ harness, root, context, defaultAgent: { model: { provider: 'openai', modelId: 'gpt-6-luna' } }, hidden: async (id) => id === (await duet.threadId()) });
  await conversations.create({ title: 'A normal chat' });
  const rows = await conversations.list();
  assert.ok(rows.some((row) => row.title === 'A normal chat'), 'normal chats are listed');
  assert.equal(rows.some((row) => row.id === thread), false, 'the Duet thread is not a chat');
  assert.deepEqual(await duet.route('GET', '/api/duet/thread'), { threadId: thread });
  passed.push('Duet left out of the chat list');

  // Typing dots for the owner's turn, not for an event turn.
  const busy = await duet.message({ text: 'WAIT owner-turn' });
  await until('owner turn running', async () => (await duet.view()).running);
  assert.equal((await duet.view()).typing, true, 'dots while Duet answers the owner');
  gate('owner-turn').release();
  await idle(busy.threadId);
  await duet.event({ text: 'WAIT event-turn', source: 'test' });
  await duet.settled();
  await until('event turn running', async () => (await duet.view()).running);
  assert.equal((await duet.view()).typing, false, 'no dots for an event turn');
  gate('event-turn').release();
  await idle(thread);
  passed.push('typing only for the owner');
  console.log('PASS duet apart: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const g of gates.values()) g.release();
  await harness.close(context).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
