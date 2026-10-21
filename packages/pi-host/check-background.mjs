// Model settings and the background model on a real Pi harness with scripted models (no
// provider is called): settings validate and persist, an automatic title is replaced once by a
// short one, an owner's rename never is, long runs of tool steps get a one-line summary keyed
// like the UI's activity groups, only tool names and arguments are sent, and a failing
// background model changes nothing.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { nativeTitleDoc } from './orchestration.mjs';
import { SummaryDoc, activityGroups, createBackground, createBackgroundExtension, createModelSettings, describeTool } from './model-settings.mjs';

const background = [];
let backgroundFails = false;
const textOf = (m) => (typeof m?.content === 'string' ? m.content : m?.content?.find?.((c) => c.type === 'text')?.text ?? '');
const reply = (model, content, stopReason = 'stop') => ({ role: 'assistant', content, api: 'fake', provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const models = {
  getModels: () => [
    { id: 'main', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 },
    { id: 'cheap', provider: 'opencode-go', api: 'fake', contextWindow: 100000, maxTokens: 1000 },
  ],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    let message;
    if (model.id === 'cheap') {
      background.push({ system: input.systemPrompt, prompt: textOf(input.messages[0]) });
      message = backgroundFails
        ? reply(model, [], 'error')
        : reply(model, [{ type: 'text', text: /name chat/.test(input.systemPrompt) ? '"Fix the deploy watchdog."' : 'Checked the host and fixed the tests.' }]);
    } else {
      const last = input.messages.at(-1);
      const text = textOf(last);
      if (last?.role === 'user' && text.startsWith('RUN ')) {
        // Three tool-only turns, then a final answer.
        message = reply(model, [{ type: 'toolCall', id: 'c' + Math.random(), name: 'host_exec', arguments: { command: text.slice(4) + ' --step 1' } }], 'toolUse');
      } else if (last?.role === 'toolResult') {
        const done = input.messages.filter((m) => m.role === 'toolResult').length;
        message = done % 3 === 0
          ? reply(model, [{ type: 'text', text: 'All done.' }])
          : reply(model, [{ type: 'toolCall', id: 'c' + Math.random(), name: 'host_exec', arguments: { command: 'npm test --step ' + (done + 1) } }], 'toolUse');
      } else message = reply(model, [{ type: 'text', text: 'Sure, here is how.' }]);
    }
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 3);
    return stream;
  },
};
const resolve = (id) => {
  const [provider, ...rest] = id.includes('/') ? id.split('/') : ['openai', id];
  return models.getModel(provider, rest.join('/'));
};
const dir = await mkdtemp(join(tmpdir(), 'mars-background-'));
const settings = createModelSettings({ file: join(dir, 'data/model-settings.json'), resolve });
const late = {};
const bg = createBackground({ harness: () => late.harness, models, settings, resolve });
const shell = defineExtension({ name: 'fake-shell', tools: [defineTool({ name: 'host_exec', description: 'Run a command.', parameters: Type.Object({ command: Type.String() }), deferred: false, replay: 'safe', execute: async () => ({ output: [{ type: 'text', text: 'SECRET OUTPUT never sent' }] }) })] });
const registry = createRegistry();
registry.install(shell);
registry.install(createBackgroundExtension({ background: bg }));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'db.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
late.harness = harness;
const agent = { model: { provider: 'openai', modelId: 'main' }, modelTools: shell.tools };
const root = await harness.root(context, { agent });
const manager = createConversationManager({ harness, root, context, defaultAgent: agent });
const until = async (test, label) => { for (let n = 0; n < 300; n++) { if (await test()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('timed out: ' + label); };
const say = async (conversation, text) => {
  await manager.autoTitle(conversation, text);
  return (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
};
const title = async (id) => (await harness.snapshot(nativeTitleDoc, id, context))?.title;

try {
  // Settings.
  assert.deepEqual(await settings.get(), { defaultModel: '', defaultEffort: '', backgroundModel: '' });
  await assert.rejects(settings.set({ backgroundModel: 'nope/x' }), /Unknown model/);
  await assert.rejects(settings.set({ defaultEffort: 'huge' }), /effort level/);
  await settings.set({ defaultModel: 'main', defaultEffort: 'high' });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'data/model-settings.json'), 'utf8')), { defaultModel: 'main', defaultEffort: 'high' });

  // Without a background model nothing is sent.
  const quiet = await manager.create({});
  await say(quiet, 'How do I restart the host?');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(background.length, 0);
  assert.equal(await title(quiet.id), 'How do I restart the host?');

  // With one: the automatic title is replaced once, and the run of tool steps is summarised.
  await settings.set({ backgroundModel: 'opencode-go/cheap' });
  const chat = await manager.create({});
  await say(chat, 'RUN git status');
  await until(async () => (await title(chat.id)) === 'Fix the deploy watchdog', 'model title');
  await until(async () => Object.keys((await harness.snapshot(SummaryDoc, chat.id, context))?.items ?? {}).length === 1, 'summary');
  const items = (await harness.snapshot(SummaryDoc, chat.id, context)).items;
  const view = await chat.viewState(context);
  const groups = activityGroups(structuredClone(view.value.entries));
  view.dispose();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tools.length, 3);
  assert.deepEqual(items, { [groups[0].key]: 'Checked the host and fixed the tests' });
  const sent = background.map((call) => call.prompt).join('\n');
  assert.ok(sent.includes('host_exec: git status --step 1'), 'tool names and arguments are sent');
  assert.ok(!sent.includes('SECRET OUTPUT'), 'tool output is never sent');
  const calls = background.length;
  await say(chat, 'Thanks');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await title(chat.id), 'Fix the deploy watchdog');
  assert.equal(background.length, calls, 'nothing new to name or summarise');

  // An owner rename is never replaced; a failing background model changes nothing.
  const renamed = await manager.create({});
  await manager.autoTitle(renamed, 'first words');
  await manager.organise({ conversationId: String(renamed.id), title: 'My own name' });
  await renamed.submit({ type: 'input', content: 'hello' }, context).then((s) => s.wait(context));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await title(renamed.id), 'My own name');
  backgroundFails = true;
  const failing = await manager.create({});
  await say(failing, 'RUN ls');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await title(failing.id), 'RUN ls');
  assert.equal(Object.keys((await harness.snapshot(SummaryDoc, failing.id, context))?.items ?? {}).length, 0);

  // Group keys follow the UI's merging: text breaks a group, tool-only turns join the next.
  const entries = [
    { id: 1, model: [{ role: 'user', content: 'go' }] },
    { id: 2, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', name: 'a', arguments: {} }] }, { role: 'toolResult', content: [] }] },
    { id: 3, model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'b', arguments: {} }] }] },
    { id: 4, model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'c', arguments: {} }] }] },
    { id: 5, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }] },
  ];
  assert.deepEqual(activityGroups(entries).map((g) => [g.key, g.tools.map((t) => t.name).join('')]), [['2:0', 'a'], ['3:0', 'bc']]);
  assert.equal(describeTool({ name: 'host_exec', arguments: { command: 'x'.repeat(500) } }).length, 'host_exec: '.length + 120);
  console.log('PASS background model: settings validate and persist, nothing sent without a background model, automatic title replaced once, long run summarised with the UI group key, only names and arguments sent, owner rename kept, failure changes nothing, group keys match UI merging');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
