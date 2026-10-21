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
import { SIDE_CHAT_DONE, SIDE_CHAT_MAX, SIDE_CHAT_PAGE, SideChatDoc, SideChatIndexDoc, SideChatNotifyDoc, createSideChat, createSideChatExtension, listSideChats } from './side-chats.mjs';

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
const extension = createSideChatExtension({ harness: () => late.harness, defaultAgent: {} });
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
  const listed = (await listSideChats({ harness, parentId: String(parent.id), context })).items.map((row) => row.id);
  assert.deepEqual(listed.sort(), [String(side.id), opened.id].sort(), 'the agent-opened side chat is nested under its parent');

  // The parent hears once when the side chat it gave work to finishes.
  const doneEntries = async () => {
    const view = await parent.viewState(context);
    try { return view.value.entries.filter((entry) => entry.kind === SIDE_CHAT_DONE); } finally { view.dispose(); }
  };
  for (let n = 0; n < 100 && !(await doneEntries()).length; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  const done = await doneEntries();
  assert.equal(done.length, 1, 'one finished note in the parent');
  assert.equal(done[0].data.sideChatId, opened.id);
  assert.match(done[0].model[0].content[0].text, /Side chat "Research" .*finished/);
  assert.equal((await harness.snapshot(SideChatNotifyDoc, research.id, context)).pending, false, 'the flag clears');
  // The owner typing in the side chat directly does not notify the parent.
  await (await research.submit({ type: 'input', content: 'owner question' }, context)).wait(context);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await doneEntries()).length, 1, 'no note for the owner\'s own messages');
  assert.equal((await say(parent, `CALL side_chat_read ${JSON.stringify({ sideChatId: opened.id })}`)).status, 'done');
  const readText = (await toolResult(parent)).text;
  let readBack;
  try { readBack = JSON.parse(readText); } catch { assert.fail('side_chat_read returned: ' + readText.slice(0, 600)); }
  assert.equal(readBack.answer, 'ok');
  assert.equal(readBack.running, false);

  assert.equal((await say(parent, 'CALL side_chat_list {}')).status, 'done');
  const toolList = JSON.parse((await toolResult(parent)).text);
  assert.deepEqual(toolList.items.map((row) => row.id).sort(), listed.sort());
  assert.equal(toolList.total, 2);

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

  assert.equal(String((await harness.snapshot(SideChatDoc, research.id, context)).parentId), String(parent.id));

  // Second review: listing is read-only, creation is one commit, paging and the cap hold.
  const docsBefore = (await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100), context)).items.length;
  const unlinked = await manager.create({ title: 'Plain' });
  await manager.list();
  assert.equal((await harness.snapshot(SideChatDoc, unlinked.id, context)), undefined, 'listing Recents never writes a side-chat document');
  assert.equal((await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100), context)).items.length, docsBefore + 1);

  const busy = await manager.create({ title: 'Busy parent' });
  const made = [];
  for (let n = 0; n < SIDE_CHAT_PAGE + 5; n++) made.push(String((await manager.create({ title: `S${n}`, parentId: String(busy.id) })).id));
  const busyRow = (await manager.list()).find((row) => row.id === String(busy.id));
  assert.equal(busyRow.sideChats.length, SIDE_CHAT_PAGE, 'Recents shows the newest page');
  assert.equal(busyRow.sideChatTotal, SIDE_CHAT_PAGE + 5, 'and says how many there are in all');
  assert.equal(busyRow.sideChats[0].title, `S${SIDE_CHAT_PAGE + 4}`, 'newest first');
  const older = await listSideChats({ harness, parentId: String(busy.id), context, offset: SIDE_CHAT_PAGE });
  assert.deepEqual(older.items.map((row) => row.title), ['S4', 'S3', 'S2', 'S1', 'S0'], 'older side chats stay reachable by offset');
  const index = await harness.snapshot(SideChatIndexDoc, busy.id, context);
  assert.deepEqual(index.children, made, 'the index lists exactly the side chats created');

  // A fork of a parent does not inherit its side chats.
  const wrote = await (await (await harness.conversation(busy.id, context)).submit({ type: 'write', entry: { kind: 'test.marker', data: {} } }, context)).wait(context);
  const forked = await manager.fork({ conversationId: String(busy.id), entryId: wrote.entry, title: 'Fork of busy' });
  assert.deepEqual((await manager.list()).find((row) => row.id === String(forked.id)).sideChats, [], 'a fork starts with no side chats');

  // A replay after a stop between the creating commit and the memo reuses the same side chat.
  const keyed = await manager.create({ title: 'Keyed parent' });
  const once = await createSideChat({ harness, parentId: String(keyed.id), agent, title: 'Once', context, requestKey: 'task-1:call-1' });
  const again = await createSideChat({ harness, parentId: String(keyed.id), agent, title: 'Once', context, requestKey: 'task-1:call-1' });
  assert.equal(String(again.id), String(once.id), 'the same request key returns the side chat it already made');
  assert.deepEqual((await harness.snapshot(SideChatIndexDoc, keyed.id, context)).children, [String(once.id)], 'and no second side chat exists');
  const other = await createSideChat({ harness, parentId: String(keyed.id), agent, title: 'Other', context, requestKey: 'task-1:call-2' });
  assert.notEqual(String(other.id), String(once.id), 'a different call makes a new side chat');

  // The cap: a flood stops at SIDE_CHAT_MAX with a clear refusal.
  const flood = await manager.create({ title: 'Flooded' });
  for (let n = 0; n < SIDE_CHAT_MAX; n++) await manager.create({ parentId: String(flood.id) });
  await assert.rejects(manager.create({ parentId: String(flood.id) }), /already has 200 side chats/);
  const started = Date.now();
  await manager.list();
  assert.ok(Date.now() - started < 1500, `Recents stays fast with ${SIDE_CHAT_MAX + SIDE_CHAT_PAGE + 10} side chats (${Date.now() - started} ms)`);
  const live = await harness.snapshot(LiveDoc, research.id, context);
  assert.equal(live?.run, undefined);
  console.log('PASS side chats: native parent link, nested rows only, selectedThread parent, refusals leave no orphan, agent open with first task, list with total, send, cross-conversation refusal, one level only, replay by request key, read-only listing, newest page plus total, offset paging, exact index, forks start empty, 200 cap, fast Recents, parent notified once when its side chat finishes (not for owner messages), side_chat_read');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// The harness keeps background schedulers alive; the check ends the process itself.
process.exit(process.exitCode ?? 0);
