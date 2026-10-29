// The one Archived list (archive.mjs, docs/LIVE-INTEGRATION.md "Archive"): archived chats and
// finished side chats, newest activity first; running side chats stay under their parent;
// children of a hidden thread are left out. Also the meter's compaction status and the Duet
// switch (docs/DUET.md "Parked"). Real Pi harness with a scripted model.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createArchive } from './archive.mjs';
import { compactionStatus } from './context-meter.mjs';
import { createConversationManager } from './conversations.mjs';
import { duetEnabled } from './duet.mjs';

let release;
const held = new Promise((resolve) => { release = resolve; });
const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.filter((m) => m.role === 'user').at(-1);
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((c) => c.text ?? '').join('');
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const aborted = () => { const m = { ...message, content: [], stopReason: 'aborted' }; stream.push({ type: 'error', reason: 'aborted', error: m }); stream.end(m); };
    options?.signal?.addEventListener?.('abort', aborted, { once: true });
    void (text.includes('HOLD') ? held : Promise.resolve()).then(() => setTimeout(() => { if (!options?.signal?.aborted) { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); } }, 5));
    return stream;
  },
};
const dir = await mkdtemp(join(tmpdir(), 'mars-archive-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const root = await harness.root(context, { agent });
let hiddenId = '';
const hidden = async (id) => id === hiddenId;
const manager = createConversationManager({ harness, root, context, defaultAgent: agent, hidden });
const archive = createArchive({ harness, context, hidden, rootId: () => root.id });
const say = async (conversation, text) => (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
const until = async (what, check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const passed = [];
try {
  const work = await manager.create({ title: 'Work chat' });
  const old = await manager.create({ title: 'Old chat' });
  await manager.organise({ conversationId: String(old.id), archived: true });
  const first = await manager.create({ parentId: String(work.id), title: 'First side chat' });
  await say(first, 'hello');
  const second = await manager.create({ parentId: String(work.id), title: 'Second side chat' });
  await say(second, 'hello');
  const busy = await manager.create({ parentId: String(work.id), title: 'Busy side chat' });
  await busy.submit({ type: 'input', content: 'HOLD' }, context);
  await until('busy side chat running', async () => !!(await harness.snapshot(LiveDoc, busy.id, context))?.run);
  const thread = await manager.create({ title: 'Hidden thread' });
  hiddenId = String(thread.id);
  const secret = await manager.create({ parentId: String(thread.id), title: 'Hidden task' });
  await say(secret, 'hello');
  // The first side chat is used again: it moves to the top of the archive.
  await say(first, 'again');

  const { items, total } = await archive.list();
  assert.deepEqual(items.map((row) => row.title), ['First side chat', 'Second side chat', 'Old chat'], 'newest activity first, finished side chats and archived chats only');
  assert.equal(total, 3);
  assert.deepEqual(items[0], { id: String(first.id), title: 'First side chat', kind: 'side', parentId: String(work.id), parentTitle: 'Work chat', status: 'done', archived: false });
  assert.equal(items[2].kind, 'chat');
  assert.equal(items.some((row) => row.title === 'Busy side chat'), false, 'a running side chat stays under its parent');
  assert.equal(items.some((row) => row.title === 'Hidden task' || row.title === 'Hidden thread'), false, 'hidden thread and its children left out');
  assert.deepEqual((await archive.list({ offset: 1, limit: 1 })).items.map((row) => row.title), ['Second side chat'], 'pages');
  await assert.rejects(archive.list({ limit: 0 }), /limit/);
  passed.push('one archive list, newest first');

  release();
  await until('busy side chat done', async () => !(await harness.snapshot(LiveDoc, busy.id, context))?.run);
  assert.equal((await archive.list()).items[0].title, 'Busy side chat', 'a side chat that finishes lands on top');
  passed.push('finished side chats archive themselves');

  assert.deepEqual(compactionStatus(undefined), { running: false });
  assert.deepEqual(compactionStatus({ compactions: [{ taskId: 4, reason: 'manual', blocking: false, attempt: 2, retry: { at: 1, error: 'overloaded' } }] }), { running: true, attempt: 2, manual: true, retryError: 'overloaded' });
  assert.deepEqual(compactionStatus({ compactionFailure: { taskId: 4, reason: 'manual', error: 'summary failed' } }), { running: false, failure: 'summary failed' });
  passed.push('compaction status');

  assert.equal(duetEnabled({}), false, 'Duet is parked by default');
  assert.equal(duetEnabled({ MARS_DUET: '1' }), true);
  passed.push('Duet parked');
  console.log('PASS archive: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  release();
  await harness.close(context).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
