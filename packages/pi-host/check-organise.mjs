// Filing conversations on a real Pi harness: rename, group, archive and auto-title are
// native documents, survive a reopen, and refuse workers and side chats.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { GROUP_MAX, OrganiseDoc, createConversationManager } from './conversations.mjs';

const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple() { throw Error('no model calls in this check'); },
};
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const dir = await mkdtemp(join(tmpdir(), 'mars-organise-'));
const open = async () => {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
  const root = await harness.root(context, { agent });
  return { harness, root, manager: createConversationManager({ harness, root, context, defaultAgent: agent }) };
};

try {
  let { harness, root, manager } = await open();
  const plain = await manager.create({});
  const rowOf = async (id) => (await manager.list()).find((row) => row.id === String(id));
  assert.deepEqual([(await rowOf(plain.id)).group, (await rowOf(plain.id)).archived], ['', false], 'new chats are unfiled and visible');

  // Auto-title names an untitled chat once, from its first message, and never renames.
  await manager.autoTitle(plain, '  Fix the   flaky deploy watchdog\nand more  ');
  assert.equal((await rowOf(plain.id)).title, 'Fix the flaky deploy watchdog and more');
  await manager.autoTitle(plain, 'Something else');
  assert.equal((await rowOf(plain.id)).title, 'Fix the flaky deploy watchdog and more', 'auto-title never renames');
  const long = await manager.create({});
  await manager.autoTitle(long, 'word '.repeat(40));
  assert.ok((await rowOf(long.id)).title.length <= 61 && (await rowOf(long.id)).title.endsWith('…'), 'long first messages are cut at a word');
  await manager.autoTitle(root, 'Should not rename root');
  assert.equal((await rowOf(root.id)).title, 'Main conversation', 'the main conversation keeps its name');

  // Rename, group and archive change only what is given.
  let row = await manager.organise({ conversationId: String(plain.id), group: '  Mars   work ' });
  assert.deepEqual([row.title, row.group, row.archived], ['Fix the flaky deploy watchdog and more', 'Mars work', false]);
  row = await manager.organise({ conversationId: String(plain.id), archived: true });
  assert.deepEqual([row.group, row.archived], ['Mars work', true], 'archiving keeps the group');
  row = await manager.organise({ conversationId: String(plain.id), title: 'Watchdog' });
  assert.deepEqual([row.title, row.group, row.archived], ['Watchdog', 'Mars work', true]);
  assert.deepEqual(await manager.selectedThread(plain.id), { conversationTitle: 'Watchdog' }, 'an archived chat still opens');

  // Pinning is a top-level flag that keeps the group and archive state.
  row = await manager.organise({ conversationId: String(plain.id), pinned: true });
  assert.deepEqual([row.pinned, row.group, row.archived], [true, 'Mars work', true], 'pinning changes only pinned');
  row = await manager.organise({ conversationId: String(plain.id), pinned: false });
  assert.equal(row.pinned, false);
  assert.equal((await rowOf(root.id)).pinned, false, 'chats start unpinned');

  // Refusals.
  await assert.rejects(manager.organise({ conversationId: String(plain.id) }), /Nothing to change/);
  await assert.rejects(manager.organise({ conversationId: String(plain.id), title: '   ' }), /title must be/);
  await assert.rejects(manager.organise({ conversationId: String(plain.id), group: 'x'.repeat(GROUP_MAX + 1) }), /at most/);
  await assert.rejects(manager.organise({ conversationId: String(plain.id), archived: 'yes' }), /true or false/);
  await assert.rejects(manager.organise({ conversationId: String(plain.id), pinned: 'yes' }), /pinned must be true or false/);
  await assert.rejects(manager.organise({ conversationId: 'x', archived: true }), /conversation id/);
  await assert.rejects(manager.organise({ conversationId: '99999', archived: true }), /not found/);
  const side = await manager.create({ parentId: String(plain.id), title: 'Side' });
  await assert.rejects(manager.organise({ conversationId: String(side.id), group: 'Mars work' }), /stays under its parent/);
  await assert.rejects(manager.organise({ conversationId: String(side.id), pinned: true }), /only top-level chats can be pinned/);
  const sideRow = await manager.organise({ conversationId: String(side.id), archived: true });
  assert.equal(sideRow.archived, true, 'a side chat can be archived');
  const nestedRows = (await manager.list()).find((row) => row.id === String(plain.id)).sideChats;
  assert.deepEqual(nestedRows, [{ id: String(side.id), title: 'Side', running: false, archived: true }], 'the parent row marks its archived side chat');
  await manager.organise({ conversationId: String(side.id), archived: false });
  assert.deepEqual((await manager.list()).find((row) => row.id === String(plain.id)).sideChats, [{ id: String(side.id), title: 'Side', running: false }]);

  assert.deepEqual(await harness.snapshot(OrganiseDoc, plain.id, context), { group: 'Mars work', archived: true, pinned: false }, 'filing is one native document');

  // Survives closing and reopening the store.
  await harness.close?.(context);
  ({ harness, root, manager } = await open());
  row = await rowOf(plain.id);
  assert.deepEqual([row.title, row.group, row.archived], ['Watchdog', 'Mars work', true], 'filing survives a restart');
  row = await manager.organise({ conversationId: String(plain.id), group: '', archived: false });
  assert.deepEqual([row.group, row.archived], ['', false], 'an empty group and archived false restore the default');
  console.log('PASS organise: rename, group, pin, archive, partial updates, auto-title once, root keeps its name, refusals, side chats archive but never join groups, one native document, survives reopen');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
