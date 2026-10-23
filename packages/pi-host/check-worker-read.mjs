// Long worker answers on a real Pi harness with a scripted model (no provider is called): a long
// answer is cut inline and marked truncated with its length, a fanout shares the inline budget,
// and worker_read returns the whole answer in parts, including the newest answer after a followup.
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
const longAnswer = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('').slice(0, n - 3) + 'END';
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
    if (last?.role === 'user' && text.startsWith('LONG ')) message.content = [{ type: 'text', text: longAnswer(Number(text.slice(5))) }];
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
const dir = await mkdtemp(join(tmpdir(), 'mars-worker-read-'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'test.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' }, modelTools: extension.tools } });
const manager = createConversationManager({ harness, root, context, defaultAgent: { model: { provider: 'openai', modelId: 'gpt-6-sol' } } });
const lastResult = async () => (await manager.state(root.id)).entries.filter((e) => e.kind === 'pi.tool-result').at(-1).model[0];
const schemaOf = (name) => Compile(extension.tools.find((t) => t.name === name).structuredOutputSchema);
try {
  const call = async (name, args) => {
    assert.equal((await (await root.submit({ type: 'input', content: `CALL ${name} ${JSON.stringify(args)}` }, context)).wait(context)).status, 'done');
    const last = await lastResult();
    assert.equal(last.isError, false, JSON.stringify(last.content).slice(0, 300));
    const value = JSON.parse(last.content.map((c) => c.text).join(''));
    assert.ok(schemaOf(name).Check(value), `${name} matches its schema: ` + JSON.stringify(value).slice(0, 200));
    return value;
  };
  const full = longAnswer(30000);
  const long = await call('worker_run', { task: 'LONG 30000', model: 'sol' });
  assert.equal(long.result[0].truncated, true);
  assert.equal(long.result[0].length, 30000);
  assert.equal(long.result[0].result, full.slice(0, 12000));
  const short = await call('worker_fanout', { jobs: [{ task: 'say hi' }, { task: 'LONG 5000' }] });
  assert.equal(short.result[0].truncated, undefined, 'a short answer is not marked');
  assert.equal(short.result[1].result.length, 5000, 'a fanout of two keeps 5000 characters inline');
  let read = '';
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    const part = await call('worker_read', { workerId: long.result[0].id, offset, limit: 20000 });
    assert.equal(part.length, 30000);
    read += part.text;
    if (!part.truncated) break;
    offset = part.nextOffset;
  }
  assert.equal(read, full, 'worker_read returns the whole answer in parts');
  const fromFollowup = await call('worker_followup', { workerId: long.result[0].id, task: 'LONG 13000' });
  assert.equal(fromFollowup.truncated, true);
  assert.equal(fromFollowup.length, 13000);
  assert.equal((await call('worker_read', { workerId: long.result[0].id, limit: 60000 })).text, longAnswer(13000), 'worker_read reads the newest answer');
  console.log('PASS worker read: long answers are cut and marked truncated, a fanout shares the inline budget, worker_read returns them whole');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
