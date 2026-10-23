import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { createOrchestrationExtension, listWorkers, stopWorker } from './orchestration.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-orchestration-'));
let active = 0, peak = 0, calls = 0;
let gate = false;
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find(m => m.id === id && m.provider === provider); },
  streamSimple(model, _input, options) {
    const stream = new AssistantMessageEventStream();
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
const extension = createOrchestrationExtension({ models, maxConcurrent: 3 });
const registry = createRegistry(); registry.install(extension);
const workflow = extension.tasks[0];
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
  const jobs = ['gpt-6-luna', 'gpt-6-sol'].map(modelId => ({ task: 'test', selection: { provider: 'openai', modelId } }));
  const taskId = await root.commit(tx => tx.createTask(workflow, { jobs }, { ownership: { kind: 'conversation' } }), context);
  const result = await harness.waitForTask(taskId, context);
  assert.equal(result.state.outcome.status, 'completed');
  assert.equal(result.state.outcome.result.length, 2);
  assert.equal(peak, 2);
  assert.equal((await manager.list()).length, 3, 'workers excluded from chat list');
  const workers = await listWorkers({ harness, conversationId: root.id, context });
  assert.equal(workers.length, 2);
  await root.configure({ modelTools: extension.tools }, context);
  const toolRun = await root.submit({ type: 'input', content: 'CALL worker_run {"task":"tool entry","model":"sol"}' }, context);
  assert.equal((await toolRun.wait(context)).status, 'done');
  const toolWorkers = await listWorkers({ harness, conversationId: root.id, context });
  assert.equal(toolWorkers.length, 3);
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
  assert.equal((await listWorkers({ harness, conversationId: root.id, context })).length, 4, 'restart reuses checkpointed child');
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
  const page = await metadataManager.listPage();
  assert.equal(page.items.length, 100);
  assert.ok(page.next, 'bounded native metadata scan exposes continuation');
  assert.equal((await metadataManager.list()).length, 100);
  assert.ok((await metadataManager.list()).some(item => item.id === String(root.id)), 'root remains selectable');
  assert.ok((await metadataManager.listPage({ cursor: page.next })).items.length > 0);
  assert.ok((await listWorkers({ harness: metadataOnly, conversationId: root.id, context })).length > 0);
  console.log(JSON.stringify({ status: 'PASS', peakConcurrent: peak, providerCalls: calls, checks: ['native conversations', 'fork', 'ownership', 'parallel selected models', 'SQLite restart checkpoint', 'native cancellation', 'usage'] }));
} finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
