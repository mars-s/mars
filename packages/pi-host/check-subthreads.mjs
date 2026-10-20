import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { createOrchestrationExtension, listWorkers, stopWorker, nativeTitleDoc } from './orchestration.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-orchestration-'));
let active = 0, peak = 0, calls = 0;
let gate = false;
const inputs = [];
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find(m => m.id === id && m.provider === provider); },
  streamSimple(model, _input, options) {
    const stream = new AssistantMessageEventStream();
    inputs.push(structuredClone(_input));
    calls++; active++; peak = Math.max(peak, active);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      active--;
      const message = { role: 'assistant', content: [{ type: 'text', text: `answer ${model.id}` }], api: 'fake', provider: model.provider, model: model.id, stopReason: options.signal.aborted ? 'aborted' : 'stop', timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const user = _input.messages.findLast(m => m.role === 'user');
      const command = typeof user?.content === 'string' ? user.content : user?.content?.find(c => c.type === 'text')?.text;
      const last = _input.messages.at(-1);
      if (command?.startsWith('CALL ') && last?.role === 'user') {
        const [, name, ...json] = command.split(' ');
        message.content = [{ type: 'toolCall', id: `call-${calls}`, name, arguments: JSON.parse(json.join(' ')) }];
        message.stopReason = 'toolUse';
      }
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
    };
    const timer = setTimeout(finish, gate ? 60000 : 60);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); finish(); }, { once: true });
    return stream;
  },
};
const extension = createOrchestrationExtension({ models, maxConcurrent: 4, loadImages: async (ids, prompt) => ({ content: [{ type: 'text', text: prompt }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], attachments: ids.map(id => ({ id, name: 'test.png' })) }) });
const registry = createRegistry(); registry.install(extension);
const workflow = extension.tasks[0];
const childBatch = defineTask({ name: 'test.child-metadata-batch', version: 1, initial: () => ({ phase: 'prepare' }), phases: {
  prepare: (task, runtime, ctx) => runtime.commit(async tx => {
    for (let i = 0; i < task.input.count; i++) await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
    return { status: 'running', checkpoint: { phase: 'finish' } };
  }, ctx),
  finish: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed' } }), ctx),
} });
registry.install({ name: 'child-metadata-test', tasks: [childBatch] });
async function open() {
  const storage = await openNodeSqliteStorage(join(dir, 'test.sqlite'));
  return Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
}
let harness = await open();
let root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' } } });
let manager = createConversationManager({ harness, root, context, defaultAgent: { model: { provider: 'openai', modelId: 'gpt-6-sol' } } });
try {
  const other = await manager.create({ title: 'Distinct chat' });
  assert.notEqual(root.id, other.id);
  assert.equal((await manager.list()).find(c => c.id === String(other.id)).title, 'Distinct chat');
  const write = await root.submit({ type: 'write', entry: { kind: 'test.marker', data: {} } }, context);
  const entry = (await write.wait(context)).entry;
  const fork = await manager.fork({ conversationId: root.id, entryId: entry, title: 'Fork' });
  assert.equal((await manager.state(fork.id)).conversation.parent.conversationId, root.id);
  await (await root.submit({ type: 'input', content: [{ type: 'text', text: 'Parent image stays here' }, { type: 'image', data: 'cGFyZW50', mimeType: 'image/png' }] }, context)).wait(context);
  const jobs = ['eggs', 'tomatoes', 'ham', 'cheese'].map(title => ({ title, task: `Prepare ${title}`, selection: { provider: 'openai', modelId: 'gpt-6-luna' }, ...(title === 'eggs' ? { attachmentIds: ['a'.repeat(64)] } : {}) }));
  const taskId = await root.commit(tx => tx.createTask(workflow, { jobs }, { ownership: { kind: 'conversation' } }), context);
  const result = await harness.waitForTask(taskId, context);
  assert.equal(result.state.outcome.status, 'completed');
  assert.equal(result.state.outcome.result.length, 4);
  assert.equal(peak, 4);
  assert.equal((await manager.list()).length, 3, 'workers excluded from chat list');
  const workers = await listWorkers({ harness, conversationId: root.id, context });
  assert.equal(workers.length, 4);
  const corruptHarness = new Proxy(harness, { get(target, key) {
    if (key === 'getTask') return async () => undefined;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const corruptManager = createConversationManager({ harness: corruptHarness, root, context, defaultAgent: {} });
  await assert.rejects(() => corruptManager.resolve(workers[0].id), /Invalid conversation owner/);
  assert.deepEqual(new Set(workers.map(w => w.title)), new Set(['eggs', 'tomatoes', 'ham', 'cheese']));
  const child = await manager.resolve(workers[0].id);
  assert.equal((await manager.selectedThread(child.id)).parentConversationId, String(root.id));
  const reply = await child.submit({ type: 'input', content: 'Selected child followup' }, context);
  assert.equal((await reply.wait(context)).status, 'done');
  assert.ok((await manager.state(child.id)).entries.length > 1);
  assert.equal((await manager.listSubthreads()).length, 4);
  assert.equal(inputs.filter(input => input.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image'))).length, 2, 'parent image and explicit worker image only, children do not inherit parent image');
  await root.configure({ modelTools: extension.tools }, context);
  const toolRun = await root.submit({ type: 'input', content: 'CALL worker_run {"task":"tool entry","model":"sol"}' }, context);
  assert.equal((await toolRun.wait(context)).status, 'done');
  const toolWorkers = await listWorkers({ harness, conversationId: root.id, context });
  assert.equal(toolWorkers.length, 5);
  assert.ok(toolWorkers[0].parentEntryId, 'tool-created worker links its native source assistant entry');
  await root.commit(async tx => { (await tx.doc(nativeTitleDoc, Number(workers[0].id))).workflowId = 'test-workflow'; }, context);
  const workerList = extension.tools.find(tool => tool.name === 'worker_list');
  const visibleWorkers = (await workerList.execute({}, { conversationId: root.id, commit: (fn, ctx) => root.commit(fn, ctx) }, context)).structuredOutput;
  assert.equal(visibleWorkers.length, 4, 'worker_list excludes ordered workflow phases');
  assert.ok(!visibleWorkers.some(row => row.id === workers[0].id), 'labelled workflow child is not an independent worker');
  assert.ok(visibleWorkers.some(row => row.id === workers[1].id), 'independent worker remains discoverable');
  assert.equal(toolWorkers[0].modelId, 'gpt-6.1-sol', 'sol alias prefers installed 6.1 model');
  const followup = await root.submit({ type: 'input', content: `CALL worker_followup ${JSON.stringify({ workerId: toolWorkers[2].id, task: 'follow up' })}` }, context);
  assert.equal((await followup.wait(context)).status, 'done');
  const followupEntries = (await manager.state(root.id)).entries.filter(e => e.kind === 'pi.tool-result');
  assert.ok(followupEntries.length >= 2);
  assert.equal(followupEntries.at(-1).model[0].isError, false, JSON.stringify(followupEntries.at(-1)));

  assert.ok(workers.every(w => w.result.includes('answer')));
  await assert.rejects(() => stopWorker({ harness, conversationId: other.id, workerId: workers[0].id, context }));
  gate = true;
  const pending = await root.commit(tx => tx.createTask(workflow, { jobs: jobs.slice(0, 1) }, { ownership: { kind: 'conversation' } }), context);
  harness.resume();
  while (active === 0) await new Promise(r => setTimeout(r, 10));
  await harness.close(context);
  gate = false;
  harness = await open(); root = await harness.root(context);
  const resumed = await harness.waitForTask(pending, context);
  assert.equal(resumed.state.outcome.status, 'completed');
  assert.equal((await listWorkers({ harness, conversationId: root.id, context })).length, 6, 'restart reuses checkpointed child');
  assert.ok((await listWorkers({ harness, conversationId: root.id, context })).some(w => w.title === 'eggs'), 'worker title survives restart');
  const newManager = createConversationManager({ harness, root, context, defaultAgent: {} });
  assert.equal((await newManager.list()).find(c => c.id === String(other.id)).title, 'Distinct chat', 'native title survives SQLite reopen');
  gate = true;
  const stoppedTask = await root.commit(tx => tx.createTask(workflow, { jobs: jobs.slice(0, 1) }, { ownership: { kind: 'conversation' } }), context);
  harness.resume();
  while (active === 0) await new Promise(r => setTimeout(r, 10));
  const runningWorker = (await listWorkers({ harness, conversationId: String(root.id), context }))[0];
  await stopWorker({ harness, conversationId: String(root.id), workerId: runningWorker.id, context });
  await harness.waitForTask(stoppedTask, context);
  assert.notEqual((await listWorkers({ harness, conversationId: root.id, context }))[0].status, 'completed', 'stopped child is not reported completed');
  const cancelled = await root.commit(tx => tx.createTask(workflow, { jobs: jobs.slice(0, 1) }, { ownership: { kind: 'conversation' } }), context);
  harness.resume();
  while (active === 0) await new Promise(r => setTimeout(r, 10));
  await harness.abortTask(cancelled, context);
  assert.equal((await harness.waitForTask(cancelled, context)).state.outcome.status, 'aborted');
  for (let i = 0; i < 105; i++) await newManager.create({ title: `Page chat ${i}` });
  const metadataOnly = new Proxy(harness, {
    get(target, key) {
      if (key === 'conversation') return () => { throw new Error('Metadata listing must not open transcript handles'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const metadataManager = createConversationManager({ harness: metadataOnly, root, context, defaultAgent: {} });
  const batchTask = await root.commit(tx => tx.createTask(childBatch, { count: 105 }, { ownership: { kind: 'conversation' } }), context);
  await harness.waitForTask(batchTask, context);
  const page = await metadataManager.listPage();
  assert.equal(page.items.length, 100, '105 newer native children cannot hide parent chats');
  assert.equal(page.items[0].title, 'Page chat 104', 'newest ownerless chat remains first');
  assert.ok(page.next, 'bounded native metadata scan exposes continuation');
  assert.equal((await metadataManager.list()).length, 100);
  assert.ok((await metadataManager.list()).some(item => item.id === String(root.id)), 'root remains selectable');
  assert.ok((await metadataManager.listPage({ cursor: page.next })).items.length > 0);
  assert.ok((await listWorkers({ harness: metadataOnly, conversationId: root.id, context })).length > 0);
  console.log(JSON.stringify({ status: 'PASS', peakConcurrent: peak, providerCalls: calls, checks: ['native conversations', 'fork', 'ownership', 'parallel selected models', 'SQLite restart checkpoint', 'native cancellation', 'usage'] }));
} finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
