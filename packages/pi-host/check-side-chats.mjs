// Side chats on a real Pi harness (docs/WORKBENCH.md "Side chats belong to their parent"):
// the native link, nesting in lists, refusals, and the agent tools driven by a scripted
// model that issues `CALL <tool> <json>`. No provider is called.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { createSideChatExtension, listSideChats } from './side-chats.mjs';

const seen = [];
const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : last?.content?.find?.((c) => c.type === 'text')?.text ?? '';
    seen.push(text);
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (last?.role === 'user' && text.startsWith('CALL ')) {
      const [, name, ...json] = text.split(' ');
      message.content = [{ type: 'toolCall', id: `call-${seen.length}`, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    }
    if (last?.role === 'toolResult') message.content = [{ type: 'text', text: `tool said ${JSON.stringify(last.content)}` }];
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 5);
    void options;
    return stream;
  },
};

const late = {};
const extension = createSideChatExtension({ createConversation: (options) => late.manager.create(options), harness: () => late.harness });
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-side-chats-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: extension.tools };
const root = await harness.root(context, { agent });
const manager = createConversationManager({ harness, root, context, defaultAgent: agent });
Object.assign(late, { harness, manager });
const toolResult = async (conversation) => {
  const view = await conversation.viewState(context);
  try {
    const results = view.value.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === 'toolResult');
    const last = results.at(-1);
    return { error: last?.isError === true, text: last?.content?.map((c) => c.text).join('') ?? '' };
  } finally {
    view.dispose();
  }
};
const say = async (conversation, text) => (await conversation.submit({ type: 'input', content: text }, context)).wait(context);

try {
  // HTTP-shaped creation through the manager: link, nesting and refusals.
  const parent = await manager.create({ title: 'Parent' });
  const side = await manager.create({ title: 'Side', parentId: String(parent.id) });
  const rows = await manager.list();
  assert.ok(!rows.some((row) => row.id === String(side.id)), 'a side chat is never its own Recents row');
  assert.deepEqual(rows.find((row) => row.id === String(parent.id)).sideChats, [{ id: String(side.id), title: 'Side', running: false }]);
  assert.deepEqual(await manager.selectedThread(side.id), { conversationTitle: 'Side', parentConversationId: String(parent.id), sideChatOf: String(parent.id) });
  const before = (await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100), context)).items.length;
  await assert.rejects(manager.create({ parentId: String(side.id) }), /cannot have its own side chats/);
  await assert.rejects(manager.create({ parentId: '99999' }), /not found/);
  await assert.rejects(manager.create({ parentId: 'x' }), /parentId must be/);
  const after = (await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100), context)).items.length;
  assert.equal(after, before, 'a refused side chat leaves no orphan conversation');

  // Agent tools: open (with a first task), list, send; replay safety; ownership.
  assert.equal((await say(parent, 'CALL side_chat_open {"title":"Research","task":"Find three names"}')).status, 'done');
  const opened = JSON.parse((await toolResult(parent)).text);
  assert.equal(opened.title, 'Research');
  assert.equal(opened.parentId, String(parent.id));
  const research = await harness.conversation(Number(opened.id), context);
  for (let n = 0; n < 50 && !seen.includes('Find three names'); n++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen.includes('Find three names'), 'the first task was sent to the new side chat');
  const listed = (await listSideChats({ harness, parentId: String(parent.id), context })).map((row) => row.id);
  assert.deepEqual(listed.sort(), [String(side.id), opened.id].sort(), 'the agent-opened side chat is nested under its parent');

  assert.equal((await say(parent, 'CALL side_chat_list {}')).status, 'done');
  assert.deepEqual(JSON.parse((await toolResult(parent)).text).map((row) => row.id).sort(), listed.sort());

  assert.equal((await say(parent, `CALL side_chat_send ${JSON.stringify({ sideChatId: opened.id, text: 'And a fourth' })}`)).status, 'done');
  assert.equal(JSON.parse((await toolResult(parent)).text).sent, true);
  for (let n = 0; n < 50 && !seen.includes('And a fourth'); n++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen.includes('And a fourth'), 'side_chat_send delivered the text');

  // Another conversation cannot reach these side chats.
  const stranger = await manager.create({ title: 'Stranger' });
  await say(stranger, `CALL side_chat_send ${JSON.stringify({ sideChatId: opened.id, text: 'hijack' })}`);
  const refused = await toolResult(stranger);
  assert.ok(refused.error && /does not belong/.test(refused.text), 'a side chat that is not the caller\'s is refused: ' + refused.text);
  assert.ok(!seen.includes('hijack'));
  await say(research, 'CALL side_chat_open {}');
  assert.ok((await toolResult(research)).error, 'a side chat cannot open side chats of its own');

  // Mutation guard for ownership: the open tool must not depend on luck for its parent.
  assert.equal(String((await harness.snapshot((await import('./side-chats.mjs')).SideChatDoc, research.id, context)).parentId), String(parent.id));
  const live = await harness.snapshot(LiveDoc, research.id, context);
  assert.equal(live?.run, undefined);
  console.log('PASS side chats: native parent link, nested rows only, selectedThread parent, refusals leave no orphan, agent open with first task, list, send, cross-conversation refusal, one level only');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// The harness keeps background schedulers alive; the check ends the process itself.
process.exit(process.exitCode ?? 0);
