// worker_run and worker_followup results match their declared schemas on a real Pi harness with a
// scripted model (no provider is called). Pi's conversation ids are numbers; codemode rejects a
// result whose ids are not the strings the schema promises.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Compile } from 'typebox/compile';
import { createConversationManager } from './conversations.mjs';
import { createOrchestrationExtension } from './orchestration.mjs';

let calls = 0;
const textOf = (m) => (typeof m?.content === 'string' ? m.content : m?.content?.find?.((c) => c.type === 'text')?.text ?? '');
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-sol'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 })),
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    calls++;
    const last = input.messages.at(-1);
    const message = { role: 'assistant', content: [{ type: 'text', text: `answer ${model.id}` }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const text = textOf(last);
    if (last?.role === 'user' && text.startsWith('CALL ')) {
      const [, name, ...json] = text.split(' ');
      message.content = [{ type: 'toolCall', id: `call-${calls}`, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    }
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 5);
    return stream;
  },
};
const extension = createOrchestrationExtension({ models, maxConcurrent: 2 });
const registry = createRegistry();
registry.install(extension);
const dir = await mkdtemp(join(tmpdir(), 'mars-worker-results-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: extension.tools } });
const manager = createConversationManager({ harness, root, context, defaultAgent: { model: { provider: 'openai', modelId: 'gpt-6-sol' } } });
const lastResult = async () => (await manager.state(root.id)).entries.filter((e) => e.kind === 'pi.tool-result').at(-1).model[0];
const schemaOf = (name) => Compile(extension.tools.find((t) => t.name === name).structuredOutputSchema);
try {
  assert.equal((await (await root.submit({ type: 'input', content: 'CALL worker_run {"task":"say hi","model":"sol"}' }, context)).wait(context)).status, 'done');
  const run = await lastResult();
  assert.equal(run.isError, false, JSON.stringify(run.content).slice(0, 300));
  const runValue = JSON.parse(run.content.map((c) => c.text).join(''));
  assert.ok(schemaOf('worker_run').Check(runValue), 'worker_run matches its schema: ' + JSON.stringify(runValue).slice(0, 200));
  assert.equal(typeof runValue.result[0].id, 'string');
  assert.equal(runValue.result[0].result, 'answer gpt-6-sol');

  const followup = `CALL worker_followup ${JSON.stringify({ workerId: runValue.result[0].id, task: 'and again' })}`;
  assert.equal((await (await root.submit({ type: 'input', content: followup }, context)).wait(context)).status, 'done');
  const more = await lastResult();
  assert.equal(more.isError, false, JSON.stringify(more.content).slice(0, 300));
  const moreValue = JSON.parse(more.content.map((c) => c.text).join(''));
  assert.ok(schemaOf('worker_followup').Check(moreValue), 'worker_followup matches its schema: ' + JSON.stringify(moreValue).slice(0, 200));
  console.log('PASS worker results: worker_run and worker_followup results match their schemas, with string ids');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
