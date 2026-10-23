// Pinning a top-level chat on a real Pi harness: a native flag on the organise document that
// keeps the group and archive state, refuses side chats and survives a reopen.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
const dir = await mkdtemp(join(tmpdir(), 'mars-pin-'));
const open = async () => {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
  const root = await harness.root(context, { agent });
  return { harness, root, manager: createConversationManager({ harness, root, context, defaultAgent: agent }) };
};

try {
  let { harness, root, manager } = await open();
  const chat = await manager.create({});
  const rowOf = async (id) => (await manager.list()).find((row) => row.id === String(id));
  assert.equal((await rowOf(chat.id)).pinned, false, 'chats start unpinned');
  await manager.organise({ conversationId: String(chat.id), group: 'Mars work', archived: true });
  let row = await manager.organise({ conversationId: String(chat.id), pinned: true });
  assert.deepEqual([row.pinned, row.group, row.archived], [true, 'Mars work', true], 'pinning changes only pinned');
  await assert.rejects(manager.organise({ conversationId: String(chat.id), pinned: 'yes' }), /pinned must be true or false/);
  const side = await manager.create({ parentId: String(chat.id), title: 'Side' });
  await assert.rejects(manager.organise({ conversationId: String(side.id), pinned: true }), /only top-level chats can be pinned/);
  await harness.close?.(context);
  ({ harness, root, manager } = await open());
  assert.equal((await rowOf(chat.id)).pinned, true, 'pinning survives a restart');
  row = await manager.organise({ conversationId: String(chat.id), pinned: false });
  assert.equal(row.pinned, false);
  console.log('PASS pin: top-level only, keeps group and archive, validated, survives reopen');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
