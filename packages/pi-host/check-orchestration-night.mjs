// Night fixes for orchestration (docs/AGENTS-AND-HOOKS.md, docs/TOOLS.md, docs/PROJECTS.md) on
// a real Pi harness with a scripted model (no provider is called):
// 1. a worker, an agent_run agent or a workflow step cannot start workers, fanouts, agents or
//    workflows, while the main chat and side chats still can;
// 2. a fanout's answers fit Pi's tool output cap in bytes, so every row arrives and cut ones say so;
// 3. workflow_status fits its answers too, keeps the last step's answer and flags cut ones;
// 4. a side chat reports the answer to the parent's own message, not the owner's turn before it,
//    and a replayed side_chat_open does not make the owner's next turn report;
// 5. a side chat note that could not be written is written on the next answer, not lost.
// Each case is checked separately; a failure is reported and the run exits 1.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createAgents, createAgentsExtension } from './agents.mjs';
import { createConversationManager } from './conversations.mjs';
import { createOrchestrationExtension, listWorkers } from './orchestration.mjs';
import { SIDE_CHAT_DONE, createSideChat, createSideChatExtension } from './side-chats.mjs';
import { createWorkflowExtension, listWorkflows } from './workflows.mjs';

const PI_DEFAULT_MAX_BYTES = 50 * 1024;
const PATTERNS = {
  md: '## Finding "one"\nThe file C:\\temp\\a.txt says "hello"\tand more.\n- item with "quotes"\n',
  cjk: '这是一个很长的回答，包含中文字符。',
};
const longText = (n, kind = 'md') => PATTERNS[kind].repeat(Math.ceil(n / PATTERNS[kind].length)).slice(0, n - 3) + 'END';
const seen = [];
const textOf = (m) => (typeof m?.content === 'string' ? m.content : m?.content?.filter?.((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '');
let calls = 0;
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 1000000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    calls++;
    const last = input.messages.at(-1);
    const text = textOf(last);
    const message = { role: 'assistant', content: [{ type: 'text', text: 'reply to: ' + text.slice(0, 200) }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    let delay = 5;
    if (last?.role === 'user') {
      seen.push(text);
      const lines = text.split('\n');
      const call = lines.find((line) => line.startsWith('CALL '));
      const long = lines.find((line) => line.startsWith('LONG '));
      if (call) {
        const [, name, ...json] = call.split(' ');
        message.content = [{ type: 'toolCall', id: 'call-' + calls, name, arguments: JSON.parse(json.join(' ')) }];
        message.stopReason = 'toolUse';
      } else if (long) {
        const [, n, kind] = long.split(' ');
        message.content = [{ type: 'text', text: longText(Number(n), kind) }];
      } else if (text.startsWith('SLOW ')) delay = 400;
    }
    if (last?.role === 'toolResult') message.content = [{ type: 'text', text: 'tool said ' + textOf(last).slice(0, 400) }];
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, delay);
    return stream;
  },
};

const dir = await mkdtemp(join(tmpdir(), 'mars-orchestration-night-'));
const agentDir = join(dir, 'agents');
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, 'helper.md'), '---\nname: helper\ndescription: Use to help.\nmodel: luna\n---\nYou help.\n');
const late = {};
let failParentOpen = null;
const orchestration = createOrchestrationExtension({ models, maxConcurrent: 4 });
const workflows = createWorkflowExtension({ models, loadImages: async () => { throw new Error('no images'); }, abortTask: (id, ctx) => late.harness.abortTask(id, ctx) });
const agentsExtension = createAgentsExtension({ agents: createAgents({ roots: [{ dir: agentDir, source: 'mars', writable: true }], cacheMs: 0, plugins: async () => [] }), models, runWorkers: orchestration.runWorkers });
// The side chats see a harness whose conversation() can fail once for one parent, as if the host stopped there.
const sideChats = createSideChatExtension({ harness: () => late.proxy, defaultAgent: {} });
const registry = createRegistry();
for (const extension of [orchestration, workflows, agentsExtension, sideChats]) registry.install(extension);
const modelTools = [orchestration, workflows, agentsExtension, sideChats].flatMap((extension) => extension.tools);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
late.harness = harness;
late.proxy = new Proxy(harness, {
  get(target, key) {
    if (key === 'conversation') return async (id, ctx) => {
      if (failParentOpen !== null && String(id) === String(failParentOpen)) { failParentOpen = null; throw new Error('host stopped here'); }
      return target.conversation(id, ctx);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools };
const root = await harness.root(context, { agent });
const manager = createConversationManager({ harness, root, context, defaultAgent: agent });
const until = async (test, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out waiting for ' + what);
};
const lastToolResult = async (conversation) => (await manager.state(conversation.id)).entries.filter((e) => e.kind === 'pi.tool-result').at(-1).model[0];
const call = async (conversation, name, args) => {
  assert.equal((await (await conversation.submit({ type: 'input', content: 'CALL ' + name + ' ' + JSON.stringify(args) }, context)).wait(context)).status, 'done');
  const result = await lastToolResult(conversation);
  const text = result.content.map((c) => c.text).join('');
  let value;
  try { value = JSON.parse(text); } catch { assert.fail(name + ' result is not whole JSON (' + Buffer.byteLength(text) + ' bytes): ...' + text.slice(-120)); }
  return { result, text, value };
};
const notesIn = async (conversation) => {
  const view = await conversation.viewState(context);
  try { return view.value.entries.filter((entry) => entry.kind === SIDE_CHAT_DONE).map((entry) => entry.model[0].content[0].text); } finally { view.dispose(); }
};
const failures = [];
const passed = [];
async function check(name, body) {
  try { await body(); passed.push(name); } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + (error?.stack || error)); }
}

try {
  await check('a worker cannot start workers (worker_run)', async () => {
    const chat = await manager.create({ title: 'Nest run' });
    const { value } = await call(chat, 'worker_run', { task: 'CALL worker_run ' + JSON.stringify({ task: 'grandchild' }) });
    const worker = value.result[0];
    assert.match(worker.result, /cannot start workers/, 'the worker was told why: ' + worker.result);
    assert.equal((await listWorkers({ harness, conversationId: worker.id, context })).length, 0, 'no grandchild worker');
  });
  await check('a worker cannot start a fanout', async () => {
    const chat = await manager.create({ title: 'Nest fanout' });
    const { value } = await call(chat, 'worker_run', { task: 'CALL worker_fanout ' + JSON.stringify({ jobs: [{ task: 'a' }, { task: 'b' }] }) });
    assert.match(value.result[0].result, /cannot start workers/);
    assert.equal((await listWorkers({ harness, conversationId: value.result[0].id, context })).length, 0);
  });
  await check('a worker cannot start a background workflow', async () => {
    const chat = await manager.create({ title: 'Nest workflow' });
    const { value } = await call(chat, 'worker_run', { task: 'CALL workflow_start ' + JSON.stringify({ title: 'Hidden', steps: [{ title: 'One', prompt: 'hi' }] }) });
    assert.match(value.result[0].result, /cannot start workers/);
    assert.deepEqual(await listWorkflows({ harness, conversationId: value.result[0].id, context }), [], 'no workflow owned by the worker');
  });
  await check('an agent_run agent cannot start agents', async () => {
    const chat = await manager.create({ title: 'Nest agent' });
    const { value } = await call(chat, 'agent_run', { agent: 'helper', task: 'CALL agent_run ' + JSON.stringify({ agent: 'helper', task: 'deeper' }) });
    assert.match(value.result, /cannot start workers/);
    assert.equal((await listWorkers({ harness, conversationId: value.id, context })).length, 0);
  });
  await check('a workflow step cannot start workers', async () => {
    const chat = await manager.create({ title: 'Nest step' });
    const { value } = await call(chat, 'workflow_start', { title: 'Steps', steps: [{ title: 'One', prompt: 'CALL worker_run ' + JSON.stringify({ task: 'from a step' }) }] });
    await harness.waitForTask(Number(value.workflowId), context);
    const [row] = await listWorkflows({ harness, conversationId: chat.id, context });
    assert.equal((await listWorkers({ harness, conversationId: row.steps[0].conversationId, context })).length, 0, 'no worker under the step');
    const { value: status } = await call(chat, 'workflow_status', { workflowId: value.workflowId });
    assert.match(status.steps[0].result, /cannot start workers/);
  });
  await check('the main chat and a side chat keep the worker tools', async () => {
    const chat = await manager.create({ title: 'Main' });
    assert.equal((await call(chat, 'worker_run', { task: 'plain job' })).value.result[0].result, 'reply to: plain job');
    const side = await harness.conversation((await createSideChat({ harness, parentId: String(chat.id), agent, title: 'Side', context })).id, context);
    assert.equal((await call(side, 'worker_run', { task: 'side job' })).value.result[0].result, 'reply to: side job');
    const { value } = await call(side, 'workflow_start', { title: 'Side flow', steps: [{ title: 'One', prompt: 'go' }] });
    assert.equal(value.status, 'started');
  });

  await check('a fanout of four long markdown answers fits the output cap', async () => {
    const chat = await manager.create({ title: 'Fanout md' });
    const { text, value } = await call(chat, 'worker_fanout', { jobs: [1, 2, 3, 4].map(() => ({ task: 'LONG 20000 md' })) });
    assert.ok(Buffer.byteLength(text) <= PI_DEFAULT_MAX_BYTES, 'within Pi\'s cap: ' + Buffer.byteLength(text));
    assert.equal(value.result.length, 4);
    for (const row of value.result) {
      assert.equal(row.truncated, true);
      assert.equal(row.length, 20000);
      assert.ok(row.result.length > 8000, 'a fair share each: ' + row.result.length);
      assert.ok(longText(20000).startsWith(row.result));
    }
    let read = '', offset = 0;
    for (let i = 0; i < 3; i++) {
      const { value: part } = await call(chat, 'worker_read', { workerId: value.result[3].id, offset, limit: 20000 });
      read += part.text;
      if (!part.truncated) break;
      offset = part.nextOffset;
    }
    assert.equal(read, longText(20000), 'worker_read still returns the whole last answer');
  });
  await check('a fanout of two CJK answers fits the output cap', async () => {
    const chat = await manager.create({ title: 'Fanout cjk' });
    const { text, value } = await call(chat, 'worker_fanout', { jobs: [{ task: 'LONG 12000 cjk' }, { task: 'LONG 12000 cjk' }] });
    assert.ok(Buffer.byteLength(text) <= PI_DEFAULT_MAX_BYTES, 'within Pi\'s cap: ' + Buffer.byteLength(text));
    for (const row of value.result) {
      assert.equal(row.truncated, true);
      assert.equal(row.length, 12000);
      assert.ok(row.result.length > 6000 && longText(12000, 'cjk').startsWith(row.result));
    }
  });
  await check('a short fanout is unchanged', async () => {
    const chat = await manager.create({ title: 'Fanout short' });
    const { value } = await call(chat, 'worker_fanout', { jobs: [{ task: 'one' }, { task: 'LONG 5000 md' }] });
    assert.equal(value.result[0].result, 'reply to: one');
    assert.equal(value.result[0].truncated, undefined);
    assert.equal(value.result[1].result, longText(5000));
  });

  await check('workflow_status of three long steps arrives whole and flags cut answers', async () => {
    const chat = await manager.create({ title: 'Flow three' });
    const { value: started } = await call(chat, 'workflow_start', { title: 'Three', steps: [1, 2, 3].map((n) => ({ title: 'Step ' + n, prompt: 'LONG 6000 md' })) });
    await harness.waitForTask(Number(started.workflowId), context);
    const { value } = await call(chat, 'workflow_status', { workflowId: started.workflowId });
    assert.equal(value.status, 'completed');
    const last = value.steps[2];
    assert.equal(last.result, longText(6000).slice(0, 4000), 'the last step keeps its stored answer');
    assert.equal(last.truncated, true);
    assert.equal(last.length, 6000);
    assert.match(value.note, /worker_read/);
    const { value: whole } = await call(chat, 'worker_read', { workerId: last.conversationId, limit: 20000 });
    assert.equal(whole.text, longText(6000), 'worker_read reads a step answer whole');
  });
  await check('workflow_status of eight steps keeps the last answer whole', async () => {
    const chat = await manager.create({ title: 'Flow eight' });
    const { value: started } = await call(chat, 'workflow_start', { title: 'Eight', steps: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ title: 'Step ' + n, prompt: 'LONG 4000 md' })) });
    await harness.waitForTask(Number(started.workflowId), context);
    const { text, value } = await call(chat, 'workflow_status', { workflowId: started.workflowId });
    assert.ok(Buffer.byteLength(text) <= 32 * 1024, 'within the declared cap: ' + Buffer.byteLength(text));
    assert.equal(value.steps.length, 8);
    assert.equal(value.steps[7].result, longText(4000));
    assert.equal(value.steps[7].truncated, undefined);
    assert.ok(value.steps.slice(0, 7).every((step) => step.truncated === true && step.length === 4000 && longText(4000).startsWith(step.result)));
  });

  await check('a side chat reports the answer to the parent\'s message, not the owner\'s turn', async () => {
    const parent = await manager.create({ title: 'Parent A' });
    const { value: opened } = await call(parent, 'side_chat_open', { title: 'Notes' });
    const side = await harness.conversation(Number(opened.id), context);
    const ownerTurn = await side.submit({ type: 'input', content: 'SLOW owner question' }, context);
    await until(() => seen.includes('SLOW owner question'), 'the owner turn to start');
    await call(parent, 'side_chat_send', { sideChatId: opened.id, text: 'parent request' });
    await ownerTurn.wait(context);
    await until(() => seen.includes('parent request'), 'the parent message to be answered');
    await until(async () => (await notesIn(parent)).length > 0, 'a note');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const notes = await notesIn(parent);
    assert.equal(notes.length, 1, 'one note: ' + JSON.stringify(notes));
    assert.match(notes[0], /reply to: parent request/);
    assert.doesNotMatch(notes[0], /owner question/);
  });
  await check('a replayed side_chat_open does not make the owner\'s next turn report', async () => {
    const parent = await manager.create({ title: 'Parent B' });
    const open = sideChats.tools.find((tool) => tool.name === 'side_chat_open');
    const memos = {};
    const api = {
      taskId: 'replayed-task', callId: 'replayed-call', conversationId: parent.id,
      memo: async (name, ...rest) => (rest.length > 1 ? (memos[name] = rest[0]) : memos[name]),
      agent: async () => agent,
      conversation: (id, ctx) => harness.conversation(id, ctx),
      commit: (body, ctx) => harness.commit(body, ctx),
    };
    const first = await open.execute({ title: 'Replayed', task: 'first job' }, api, context);
    const id = Number(first.structuredOutput.id);
    await until(async () => (await notesIn(parent)).length === 1, 'the first note');
    await open.execute({ title: 'Replayed', task: 'first job' }, api, context);
    const side = await harness.conversation(id, context);
    await (await side.submit({ type: 'input', content: 'owner chat' }, context)).wait(context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const notes = await notesIn(parent);
    assert.equal(notes.length, 1, 'still one note: ' + JSON.stringify(notes));
    assert.match(notes[0], /reply to: first job/);
  });
  await check('a side chat note that could not be written arrives on the next answer', async () => {
    const parent = await manager.create({ title: 'Parent C' });
    const { value: opened } = await call(parent, 'side_chat_open', { title: 'Fragile' });
    failParentOpen = parent.id;
    await call(parent, 'side_chat_send', { sideChatId: opened.id, text: 'parent job' });
    await until(() => seen.includes('parent job') && failParentOpen === null, 'the failed note attempt');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await notesIn(parent)).length, 0, 'the first attempt wrote nothing');
    const side = await harness.conversation(Number(opened.id), context);
    await (await side.submit({ type: 'input', content: 'owner later' }, context)).wait(context);
    await until(async () => (await notesIn(parent)).length > 0, 'the note on the next answer', 2000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const notes = await notesIn(parent);
    assert.equal(notes.length, 1, 'the note was not lost: ' + JSON.stringify(notes));
    assert.match(notes[0], /reply to: parent job/, 'it carries the answer to the parent\'s message');
  });
} finally {
  await harness.close(context).catch(() => {});
}
if (failures.length) {
  console.error('FAIL orchestration night: ' + failures.length + ' of ' + (failures.length + passed.length) + ' failed: ' + failures.join('; '));
  process.exit(1);
}
console.log('PASS orchestration night: ' + passed.join('; '));
process.exit(0);
