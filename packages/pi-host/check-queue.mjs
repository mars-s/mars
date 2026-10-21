// Queue and steer on a real Pi harness with a scripted, gated model (no provider is called):
// messages sent during a reply wait in Pi's inbox, a steered one reaches the running reply at
// its next tool boundary, a removed one is never sent, and Stop keeps the queue.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, InboxDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createPlanExtension } from './plans.mjs';
import { abortKeepingQueue, removeQueued, steerQueued, whenBusy } from './queue.mjs';

const seen = [];
let gate;
let release = () => {};
const hold = () => { gate = new Promise((resolve) => { release = resolve; }); };
const textOf = (message) => typeof message?.content === 'string' ? message.content : message?.content?.find?.((c) => c.type === 'text')?.text ?? '';
const models = {
  getModels: () => [{ id: 'fake', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const users = input.messages.filter((m) => m.role === 'user').map(textOf);
    seen.push({ last: last?.role === 'user' ? textOf(last) : last?.role, users });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const text = textOf(last);
    if (last?.role === 'user' && text.startsWith('CALL ')) {
      const [, name, ...json] = text.split(' ');
      message.content = [{ type: 'toolCall', id: `call-${seen.length}`, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    }
    const wait = last?.role === 'user' && text.startsWith('CALL ') ? gate : Promise.resolve();
    const finish = () => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); };
    const aborted = () => { const m = { ...message, content: [], stopReason: 'aborted' }; stream.push({ type: 'error', reason: 'aborted', error: m }); stream.end(m); };
    options?.signal?.addEventListener?.('abort', aborted, { once: true });
    void wait.then(() => setTimeout(() => { if (!options?.signal?.aborted) finish(); }, 5));
    return stream;
  },
};
const extension = createPlanExtension();
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-queue-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'fake' }, modelTools: extension.tools } });
const inbox = async () => ((await harness.snapshot(InboxDoc, root.id, context))?.items ?? []).map((item) => [textOf(item), item.mode]);
const send = (text, mode) => root.submit({ type: 'input', content: text, whenBusy: whenBusy(mode) }, context);
const until = async (test, label) => {
  for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail('timed out waiting for ' + label);
};
const plan = 'CALL plan_update ' + JSON.stringify({ steps: [{ step: 'Look', status: 'in_progress' }] });

try {
  assert.equal(whenBusy(undefined), 'followUp', 'queue is the default');
  assert.equal(whenBusy('steer'), 'steer');
  assert.throws(() => whenBusy('now'), /mode must be/);

  // A reply is running (its first model call is held). Three messages queue behind it.
  hold();
  const first = await send(plan);
  await until(() => seen.length === 1, 'first model call');
  const a = await send('Use the blue one');
  const b = await send('Then write it up');
  const c = await send('Never mind this');
  assert.deepEqual(await inbox(), [['Use the blue one', 'followUp'], ['Then write it up', 'followUp'], ['Never mind this', 'followUp']]);

  // Remove one, steer one.
  assert.deepEqual(await removeQueued({ harness, conversation: root, submissionId: String(c.id), context }), { removed: true });
  const steered = await steerQueued({ harness, conversation: root, submissionId: String(a.id), context });
  assert.equal(steered.steered, true);
  assert.deepEqual(await inbox(), [['Then write it up', 'followUp'], ['Use the blue one', 'steer']], 'the steered message moved to the steer lane');
  await assert.rejects(steerQueued({ harness, conversation: root, submissionId: String(c.id), context }), /no longer queued/);
  await assert.rejects(removeQueued({ harness, conversation: root, submissionId: 'x', context }), /queued message id/);

  // Release: the tool runs, and the steer reaches the same reply before its next model call.
  release();
  await first.wait(context);
  await until(async () => (await inbox()).length === 0 && seen.some((call) => call.last === 'Then write it up'), 'queue drained');
  await root.waitForIdle(context);
  const afterTool = seen[1];
  assert.equal(afterTool.last, 'Use the blue one', 'the steer is the next thing the running reply sees after its tool');
  assert.ok(seen.findIndex((call) => call.last === 'Then write it up') > 1, 'the queued message ran after the reply finished');
  assert.ok(!seen.some((call) => call.users.includes('Never mind this')), 'a removed message is never sent');

  // Stop keeps the queue: the queued message starts the next reply.
  hold();
  const second = await send(plan);
  await until(() => seen.at(-1).last === plan, 'second reply started');
  await send('Keep me');
  const stopped = await abortKeepingQueue({ harness, conversation: root, context });
  assert.deepEqual(stopped, { aborted: true, kept: 1 });
  release();
  await second.wait(context).catch(() => {});
  await until(() => seen.some((call) => call.last === 'Keep me'), 'kept message ran after Stop');
  await root.waitForIdle(context);
  console.log('PASS queue: queue by default, remove, steer moves to the steer lane and reaches the running reply after its tool, queued message runs after the reply, removed never sent, Stop keeps the queue');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
