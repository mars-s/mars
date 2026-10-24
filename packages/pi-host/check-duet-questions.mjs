// Duet sends one message per question (docs/DUET.md "Reporting"): a final answer that repeats
// the question a task just posted is not posted again, a final answer that ends in a question is
// posted once as a question and the task waits for the owner, and the owner's reply runs it on to
// a result. Real Pi harness, scripted model, no provider.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createDuet, createDuetExtension, repeats } from './duet.mjs';

const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
let calls = 0;
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    calls++;
    const turns = input.messages.filter((m) => m.role !== 'system');
    const last = turns.at(-1);
    const text = last?.role === 'user' ? textOf(last) : '';
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const line = (/(?:^|\n|\]: )((?:CALL|SAY) [^\n]*)/.exec(text) || [])[1] || '';
    if (line.startsWith('CALL ')) {
      const [, name, ...json] = line.split(' ');
      message.content = [{ type: 'toolCall', id: 'call-' + calls, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    } else if (line.startsWith('SAY ')) message.content = [{ type: 'text', text: line.slice(4) }];
    else if (last?.role === 'toolResult') {
      // Like the model in the owner's screenshot: it says its question again as the final answer.
      const call = turns.at(-2)?.content?.find?.((c) => c.type === 'toolCall');
      message.content = [{ type: 'text', text: call?.name === 'duet_post' && call.arguments.kind === 'question' ? call.arguments.text.replace('?', '? I will wait until you tell me.') : 'Report finished: 12 pages' }];
    }
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 5);
    return stream;
  },
};
const late = {};
const duet = createDuet({ harness: () => late.harness, models, context, defaultAgent: () => ({ model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: late.tools }), openProject: async () => ({ root: '' }) });
const extension = createDuetExtension({ duet });
late.tools = extension.tools;
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-duet-questions-'));
late.harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
await late.harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: extension.tools } });
const until = async (what, check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const posts = async (taskId) => (await duet.view()).messages.filter((m) => m.from === 'duet' && m.taskId === taskId);
const state = async (taskId) => (await duet.tasks(await duet.threadId())).find((row) => row.id === taskId)?.state;
const idle = async (conversationId) => !(await late.harness.snapshot(LiveDoc, Number(conversationId), context))?.run;

try {
  assert.equal(repeats('What topic would you like me to search for? I will wait until you tell me.', ['What topic would you like me to search for?']), true);
  assert.equal(repeats('Here are three hotels near the station.', ['What topic would you like me to search for?']), false);
  assert.equal(repeats('anything', []), false);

  const thread = await duet.ensureThread();
  // A task posts a question with duet_post, then repeats it as its final answer: one message.
  const asked = await duet.startTask({ thread, label: 'Web search', brief: 'CALL duet_post ' + JSON.stringify({ kind: 'question', text: 'What topic would you like me to search for?' }), origin: 'do a web search' });
  await until('the question', async () => (await posts(asked.taskId)).length >= 1);
  await until('the task idle', () => idle(asked.conversationId));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const once = await posts(asked.taskId);
  assert.equal(once.length, 1, 'one message, not the question and its repeat: ' + JSON.stringify(once.map((m) => m.text)));
  assert.equal(once[0].kind, 'question');
  assert.equal(await state(asked.taskId), 'waiting', 'the task waits for the owner');

  // The owner answers by replying to it: the task runs on and its result is posted.
  await duet.message({ text: 'SAY Found three articles on Duet', taskId: asked.taskId });
  await until('the result', async () => (await posts(asked.taskId)).some((m) => m.kind === 'result' && m.text === 'Found three articles on Duet'));
  assert.equal(await state(asked.taskId), 'done');

  // A final answer that ends in a question is posted once, as a question, and waits.
  const direct = await duet.startTask({ thread, label: 'Files', brief: 'SAY Which folder should I clean up?' });
  await until('the direct question', async () => (await posts(direct.taskId)).length === 1);
  const [question] = await posts(direct.taskId);
  assert.equal(question.kind, 'question');
  assert.equal(await state(direct.taskId), 'waiting');

  // A different final answer after an update is still posted.
  const updated = await duet.startTask({ thread, label: 'Report', brief: 'CALL duet_post ' + JSON.stringify({ kind: 'update', text: 'Halfway through the report' }) });
  await until('the update and the result', async () => (await posts(updated.taskId)).length === 2);
  assert.deepEqual((await posts(updated.taskId)).map((m) => m.kind), ['update', 'result']);
  console.log('PASS duet questions: a repeated question is posted once and the task waits; the owner reply runs it on to a result; a final question waits; a different result after an update is posted');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
