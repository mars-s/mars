import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
const { createWorkflowExtension, listWorkflows, stopWorkflow } = await import(process.env.MARS_WORKFLOW_MODULE ? pathToFileURL(process.env.MARS_WORKFLOW_MODULE).href : './workflows.mjs');
const directory = process.env.MARS_WORKFLOW_CRASH_DIR || await mkdtemp(join(tmpdir(), 'mars-workflows-'));
const crashMode = process.env.MARS_WORKFLOW_CRASH_MODE;
const calls = [];
const held = new Set();
let hold = true;
let harness;
const usage = { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 2000 })),
  getModel(provider, id) { return this.getModels().find(model => model.provider === provider && model.id === id); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const user = input.messages.findLast(message => message.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : user?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const child = prompt?.startsWith('Workflow ');
    calls.push({ modelId: model.id, prompt, child, messages: structuredClone(input.messages) });
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      held.delete(finish);
      const message = { role: 'assistant', content: [{ type: 'text', text: child ? `RESULT_${prompt.match(/Step (\d+)/)?.[1]}_` + 'x'.repeat(5000) : 'Parent returned immediately' }], api: 'fake', provider: model.provider, model: model.id, stopReason: options.signal.aborted ? 'aborted' : 'stop', timestamp: Date.now(), usage };
      if (prompt?.startsWith('CALL ') && last?.role === 'user') {
        message.content = [{ type: 'toolCall', id: `call-${calls.length}`, name: 'workflow_start', arguments: JSON.parse(prompt.slice(5)) }];
        message.stopReason = 'toolUse';
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    }
    if (child && hold && (crashMode !== 'write' || prompt.includes('Step 2/3'))) held.add(finish);
    else queueMicrotask(finish);
    options.signal.addEventListener('abort', finish, { once: true });
    return stream;
  },
};
const extension = createWorkflowExtension({ models, loadImages: () => { throw Error('Unreferenced images must not load'); }, abortTask: (id, ctx) => harness.abortTask(id, ctx) });
const registry = createRegistry();
registry.install(extension);
async function open() {
  const storage = await openNodeSqliteStorage(join(directory, 'workflows.sqlite'));
  return Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
}
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const steps = ['Map', 'Pick', 'Explain'].map((title, index) => ({ title, prompt: `Brief for ${title}`, selection: { provider: 'openai', modelId: models.getModels()[index].id } }));
async function crashCheck() {
  const crashDirectory = await mkdtemp(join(tmpdir(), 'mars-workflow-kill-'));
  async function child(mode, expected) {
    const processChild = fork(new URL(import.meta.url), [], { env: { ...process.env, MARS_WORKFLOW_CRASH_DIR: crashDirectory, MARS_WORKFLOW_CRASH_MODE: mode, ...(expected ? { MARS_WORKFLOW_EXPECTED: JSON.stringify(expected) } : {}) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error(`Crash subprocess timed out (${mode})`)), 15000);
        processChild.once('message', value => { clearTimeout(timeout); resolve(value); });
        processChild.once('exit', code => { clearTimeout(timeout); reject(Error(`Crash subprocess exited early (${code})`)); });
      });
      if (mode === 'write') {
        const exited = new Promise(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal })));
        processChild.kill('SIGKILL');
        assert.equal((await exited).signal, 'SIGKILL');
      } else await new Promise((resolve, reject) => processChild.once('exit', code => code === 0 ? resolve() : reject(Error(`Recovery exited ${code}`))));
      return result;
    } finally { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); }
  }
  try {
    const before = await child('write');
    const after = await child('read', before);
    assert.equal(after.status, 'PASS');
  } finally { await rm(crashDirectory, { recursive: true, force: true }); }
}
if (crashMode) {
  hold = crashMode === 'write';
  harness = await open();
  const root = await harness.root(context, { agent: { model: steps[0].selection } });
  if (crashMode === 'write') {
    await root.commit(tx => tx.createTask(extension.tasks[0], { title: 'Kill recovery', steps, startedAt: Date.now() }, { ownership: { kind: 'conversation' }, background: true }), context);
    harness.resume();
    await until(() => held.size === 1, 'second phase held before SIGKILL');
    const row = (await listWorkflows({ harness, conversationId: root.id, context }))[0];
    assert.equal(row.steps[0].status, 'completed');
    assert.equal(row.steps[1].status, 'running');
    process.send({ id: row.id, childIds: row.steps.slice(0, 2).map(step => step.conversationId) });
    setInterval(() => {}, 1000);
  } else {
    const expected = JSON.parse(process.env.MARS_WORKFLOW_EXPECTED);
    assert.equal((await harness.waitForTask(Number(expected.id), context)).state.outcome.status, 'completed');
    const rows = await listWorkflows({ harness, conversationId: root.id, context });
    assert.equal(rows.length, 1, 'crash recovery must not duplicate workflow');
    assert.deepEqual(rows[0].steps.slice(0, 2).map(step => step.conversationId), expected.childIds);
    assert.equal(new Set(rows[0].steps.map(step => step.conversationId)).size, 3);
    assert(!calls.some(call => call.child && call.prompt.includes('Step 1/3')), 'completed phase must not rerun after SIGKILL');
    for (const step of rows[0].steps) {
      const transcript = await (await harness.conversation(Number(step.conversationId), context)).context(context);
      assert.equal(transcript.messages.filter(message => message.role === 'user').length, 1, 'crash replay must not duplicate phase input');
    }
    const transcript = await root.context(context);
    assert.equal(transcript.entries.filter(entry => entry.kind === 'mars.workflow-completed').length, 1);
    await harness.close(context);
    process.send({ status: 'PASS' });
    process.disconnect();
  }
} else try {
  harness = await open();
  let root = await harness.root(context, { agent: { model: steps[0].selection } });
  await root.configure({ modelTools: extension.tools }, context);
  const run = await root.submit({ type: 'input', content: `CALL ${JSON.stringify({ title: 'Choose a route', steps: steps.map(({ selection, ...step }) => ({ ...step, ...selection })) })}` }, context);
  const settled = await Promise.race([run.wait(context), new Promise((_, reject) => setTimeout(() => reject(Error('Parent blocked on background workflow')), 10000).unref())]);
  assert.equal(settled.status, 'done');
  await until(() => held.size === 1, 'held first step');
  let rows = await listWorkflows({ harness, conversationId: root.id, context });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].steps[0].status, 'running');
  assert.deepEqual(rows[0].steps.map(step => step.title), ['Map', 'Pick', 'Explain']);
  const workflowId = rows[0].id;
  const firstChild = rows[0].steps[0].conversationId;
  assert.equal(calls.filter(call => call.child).length, 1);
  await harness.close(context);
  hold = false;
  harness = await open();
  root = await harness.root(context);
  const finished = await harness.waitForTask(Number(workflowId), context);
  assert.equal(finished.state.outcome.status, 'completed');
  rows = await listWorkflows({ harness, conversationId: String(root.id), context });
  assert.equal(rows[0].steps[0].conversationId, firstChild, 'restart reuses checkpointed native child');
  assert.deepEqual(rows[0].steps.map(step => step.status), ['completed', 'completed', 'completed']);
  assert.deepEqual(rows[0].steps.map(step => step.modelId), steps.map(step => step.selection.modelId));
  assert(rows[0].steps.every(step => step.durationMs >= 0 && step.finishedAt >= step.startedAt));
  assert(rows[0].steps.every(step => Object.keys(step.usage.models).length > 0));
  assert(rows[0].steps.every(step => step.result === undefined), 'list metadata excludes model answers');
  const childCalls = calls.filter(call => call.child);
  const pick = childCalls.find(call => call.prompt.includes('Step 2/3'));
  const explain = childCalls.find(call => call.prompt.includes('Step 3/3'));
  assert(pick.prompt.includes('RESULT_1_'));
  assert(explain.prompt.includes('RESULT_2_'));
  assert(!explain.prompt.includes('RESULT_1_'), 'only immediate predecessor is transferred');
  assert(pick.prompt.length < 4300 && explain.prompt.length < 4300, 'transferred answers are bounded');
  assert.equal(pick.modelId, steps[1].selection.modelId);
  assert.equal(explain.modelId, steps[2].selection.modelId);
  const firstHandle = await harness.conversation(Number(firstChild), context);
  const firstTranscript = await firstHandle.context(context);
  assert.equal(firstTranscript.messages.filter(message => message.role === 'user').length, 1, 'stable request ID prevents duplicate child input on restart');
  const transcript = await root.context(context);
  assert.equal(transcript.entries.filter(entry => entry.kind === 'mars.workflow-completed' && entry.data.workflowId === workflowId).length, 1);
  hold = true;
  const cancelled = await root.commit(tx => tx.createTask(extension.tasks[0], { title: 'Cancel route', steps, startedAt: Date.now() }, { ownership: { kind: 'conversation' }, background: true }), context);
  harness.resume();
  await until(() => held.size === 1, 'active cancellable native step');
  const callsBeforeStop = calls.filter(call => call.child).length;
  await assert.rejects(stopWorkflow({ harness, conversationId: 999999, workflowId: String(cancelled), context }), /not found/);
  await stopWorkflow({ harness, conversationId: root.id, workflowId: String(cancelled), context });
  assert.equal((await harness.waitForTask(cancelled, context)).state.outcome.status, 'aborted');
  const stopped = (await listWorkflows({ harness, conversationId: root.id, context })).find(row => row.id === String(cancelled));
  assert.equal(stopped.steps[0].status, 'aborted');
  assert(stopped.steps.slice(1).every(step => step.status === 'pending'));
  assert.equal(calls.filter(call => call.child).length, callsBeforeStop, 'stop never launches later phases');
  await until(() => held.size === 0, 'active child abort');
  await crashCheck();
  console.log(JSON.stringify({ status: 'PASS', checks: ['native workflow_start tool', 'immediate parent reply', 'ordered bounded phase transfer', 'selected models', 'SQLite restart stable child', 'native usage and timing', 'completion once', 'active child stop', 'SIGKILL second-phase recovery without duplicate IDs or inputs'] }));
} finally {
  if (harness) await harness.close(context);
  await rm(directory, { recursive: true, force: true });
}
