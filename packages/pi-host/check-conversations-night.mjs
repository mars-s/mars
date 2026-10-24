// Night fixes for conversations, on a real Pi harness: the sidebar list keeps pinned chats
// however many newer chats there are, without loading every older chat.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';

const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple() { throw Error('no model calls in this check'); },
};
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const dir = await mkdtemp(join(tmpdir(), 'mars-conversations-night-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
try {
  const root = await harness.root(context, { agent });
  const manager = createConversationManager({ harness, root, context, defaultAgent: agent });
  const ids = async () => (await manager.list()).map((row) => row.id);

  // An old unpinned chat and an old pinned one, in a group, then 99 newer chats: the pinned chat
  // is the last row of the first page, where the main conversation used to push it out.
  const unpinned = await manager.create({ title: 'Old and unpinned' });
  const pinned = await manager.create({ title: 'Pinned for good' });
  await manager.organise({ conversationId: String(pinned.id), pinned: true, group: 'Keep' });
  const side = await manager.create({ parentId: String(pinned.id), title: 'Its side chat' });
  for (let n = 0; n < 99; n++) await manager.create({ title: `Scheduled run ${n}` });
  let list = await manager.list();
  let row = list.find((item) => item.id === String(pinned.id));
  assert.ok(row, 'a pinned chat at the end of the first page stays when the main conversation is added');
  assert.deepEqual([row.pinned, row.group, row.title], [true, 'Keep', 'Pinned for good']);
  assert.deepEqual(row.sideChats.map((item) => item.id), [String(side.id)], 'it keeps its side chats');
  assert.ok(list.some((item) => item.id === String(root.id)), 'the main conversation is listed');

  // Many more newer chats: the pinned chat is far past the first page and still listed, once.
  for (let n = 99; n < 260; n++) await manager.create({ title: `Scheduled run ${n}` });
  list = await manager.list();
  assert.equal(list.filter((item) => item.id === String(pinned.id)).length, 1, 'a pinned chat older than the first page stays, once');
  assert.ok(!(await ids()).includes(String(unpinned.id)), 'an old unpinned chat stays on its later page');
  assert.ok(!(await ids()).includes(String(side.id)), 'side chats are never top-level rows');
  assert.ok((await ids()).includes(String(root.id)), 'the main conversation is still listed');
  assert.equal(list.length, 101, 'the newest 99, the main conversation and the pinned chat');

  // The main conversation pinned and old is listed once; unpinning lets a chat go back to its page.
  await manager.organise({ conversationId: String(root.id), pinned: true });
  assert.equal((await ids()).filter((id) => id === String(root.id)).length, 1, 'a pinned main conversation is listed once');
  await manager.organise({ conversationId: String(pinned.id), pinned: false });
  assert.ok(!(await ids()).includes(String(pinned.id)), 'an unpinned old chat leaves the sidebar list');
  process.stdout.write(JSON.stringify({ passed: true, checks: ['pinned chat at the page edge', 'pinned chat past the first page', 'old unpinned chats stay paged', 'pinned main conversation once', 'unpinning'] }) + '\n');
} finally {
  await harness.close?.(context);
  await rm(dir, { recursive: true, force: true });
}
