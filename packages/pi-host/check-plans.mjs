// plan_update on a real Pi harness, driven by a scripted model that issues `CALL <tool> <json>`
// (docs/TOOLS.md "plan_update"). No provider is called.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Compile } from 'typebox/compile';
import { PLAN_LIMIT, createPlanExtension, preparePlan, readPlan } from './plans.mjs';

const models = {
  getModels: () => [{ id: 'fake', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : last?.content?.find?.((c) => c.type === 'text')?.text ?? '';
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (last?.role === 'user' && text.startsWith('CALL ')) {
      const [, name, ...json] = text.split(' ');
      message.content = [{ type: 'toolCall', id: `call-${Date.now()}`, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    }
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 5);
    return stream;
  },
};
const extension = createPlanExtension();
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-plans-'));
const storage = await openNodeSqliteStorage(join(dir, 'test.sqlite'));
const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'fake' }, modelTools: extension.tools } });
const say = async (args) => (await root.submit({ type: 'input', content: `CALL plan_update ${JSON.stringify(args)}` }, context)).wait(context);
const lastResult = async () => {
  const view = await root.viewState(context);
  try {
    const result = view.value.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === 'toolResult').at(-1);
    return { error: result?.isError === true, text: result?.content?.map((c) => c.text).join('') ?? '' };
  } finally {
    view.dispose();
  }
};
const tool = extension.tools[0];
const accepts = (args) => Compile(tool.parameters).Check(preparePlan(args));

try {
  assert.equal(await readPlan(harness, root.id, context), null, 'no plan until one is written');
  const steps = [
    { step: 'Find the video in the GitHub PR', status: 'in_progress' },
    { step: 'Work out a CDN URL that serves it', status: 'pending' },
    { step: 'Add Video.js player to the page', status: 'pending' },
    { step: 'Check it plays in the browser', status: 'pending' },
  ];
  await say({ steps });
  assert.deepEqual(JSON.parse((await lastResult()).text), { steps, done: 0, total: 4, next: 'Find the video in the GitHub PR' });
  assert.deepEqual((await readPlan(harness, root.id, context)).steps, steps, '/api/state reads the plan the agent wrote');

  // Tick off as work progresses; the whole list replaces the last one.
  const progressed = steps.map((step, index) => ({ ...step, status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending' }));
  await say({ steps: progressed });
  assert.deepEqual(await readPlan(harness, root.id, context), { steps: progressed, done: 1, total: 4, next: 'Work out a CDN URL that serves it' });

  // Two steps in progress at once is refused, and the saved plan is unchanged.
  await say({ steps: progressed.map((step) => ({ ...step, status: 'in_progress' })) });
  const refused = await lastResult();
  assert.ok(refused.error && /Only one step/.test(refused.text), refused.text);
  assert.equal((await readPlan(harness, root.id, context)).done, 1);

  // Everything done, then cleared.
  await say({ steps: steps.map((step) => ({ ...step, status: 'completed' })) });
  assert.deepEqual(await readPlan(harness, root.id, context).then((plan) => [plan.done, plan.total, plan.next]), [4, 4, null]);
  await say({ steps: [] });
  assert.equal(await readPlan(harness, root.id, context), null, 'an empty list clears the plan');

  // Forgiving input, as small models send it, and what is still refused.
  assert.ok(accepts({ steps: ['Run the tests', 'Fix failures'] }), 'plain strings become pending steps');
  assert.ok(accepts({ steps: '[{"step":"a","status":"done"}]' }), 'a JSON string and "done" are accepted');
  assert.ok(accepts({ steps: [{ text: 'a', status: 'Doing' }] }), 'text for step and "Doing" are accepted');
  assert.ok(accepts({ plan: [{ title: 'a', status: 'complete' }] }), 'plan and title are accepted');
  assert.ok(!accepts({ steps: [{ step: 'a', status: 'maybe' }] }), 'an unknown status is still refused');
  assert.ok(!accepts({ steps: Array.from({ length: PLAN_LIMIT + 1 }, (_, n) => `step ${n}`) }), `more than ${PLAN_LIMIT} steps is refused`);
  console.log('PASS plans: written by the agent through a real harness, read back for /api/state, progress replaces the list, one step in progress at a time, done and cleared, forgiving input with unknown status and over-long plans still refused');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
