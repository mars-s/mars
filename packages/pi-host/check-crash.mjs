import assert from 'node:assert/strict';
import { mkdtemp, appendFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineTool, defineExtension } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createVmControl } from './vm-control.mjs';
const { createDiscovery } = await import(process.env.MARS_DISCOVERY_MODULE ?? new URL('./discovery.mjs', import.meta.url).href);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function open(root) {
  const discovery = createDiscovery();
  const registry = createRegistry();
  for (const extension of discovery.extensions) registry.install(extension);
  registry.install(createVmControl({ root, cwd: root }).extension);
  registry.install(defineExtension({ name: 'crash-probe', tools: [defineTool({
    name: 'probe_read', description: 'Count completed calls for crash recovery verification.',
    parameters: Type.Object({}), structuredOutputSchema: Type.Any(), deferred: true, replay: 'safe',
    execute: async () => {
      await appendFile(join(root, 'reads'), 'read\n');
      return { output: [{ type: 'text', text: 'completed read' }], structuredOutput: { completed: true } };
    },
  })] }));
  const command = `printf '%s' "$$" > ${shellQuote(join(root, 'group'))}; printf 'effect\\n' >> ${shellQuote(join(root, 'effects'))}; sleep 60`;
  const code = `const read = await tools.probe_read({});\ntry { const value = await tools.host_exec(${JSON.stringify({ command })}); text({unexpected:value}); } catch(error) { text("INTERRUPTED:" + error.message); }\ntext({read});`;
  const model = { id: 'fixture', provider: 'fixture', api: 'fake', contextWindow: 100000, maxTokens: 1000 };
  const models = {
    getModel: () => model, getModels: () => [model],
    streamSimple(_model, input) {
      const stream = new AssistantMessageEventStream();
      const call = input.messages.at(-1)?.role === 'user';
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: 'toolCall', id: 'crash-codemode', name: 'codemode', arguments: { code } }] : [{ type: 'text', text: 'recovery finished' }],
        stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
      return stream;
    },
  };
  const storage = await openNodeSqliteStorage(join(root, 'crash.sqlite'));
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, modelTools: discovery.modelTools } });
  return { harness, conversation };
}

if (process.argv[2] === 'child') {
  const root = process.argv[3];
  const { harness, conversation } = await open(root);
  await conversation.submit({ type: 'input', content: 'Run crash probe once.' }, context);
  await conversation.waitForIdle(context);
  await harness.close(context);
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'mars-real-crash-'));
let child;
let closed;
let harness;
let childError = '';
function killGroup() {
  return readFile(join(root, 'group'), 'utf8').then(value => {
    const pid = Number(value);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return rm(join(root, 'group'), { force: true });
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
try {
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', chunk => { childError = (childError + chunk).slice(-6000); });
  for (let attempt = 0; ; attempt++) {
    try { await access(join(root, 'effects')); break; } catch {
      assert.equal(child.exitCode, null, childError);
      assert.ok(attempt < 1000, 'unsafe nested host_exec started before crash\n' + childError);
      await pause(20);
    }
  }
  assert.equal(await readFile(join(root, 'reads'), 'utf8'), 'read\n');
  child.kill('SIGKILL');
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
  await killGroup();
  const reopened = await open(root);
  harness = reopened.harness;
  harness.resume();
  let timeout;
  try {
    await Promise.race([reopened.conversation.waitForIdle(context), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Crash recovery timed out')), 15000); })]);
  } finally { clearTimeout(timeout); }
  const view = await reopened.conversation.context(context);
  const toolResults = view.entries.filter(entry => entry.kind === 'pi.tool-result');
  const serialised = JSON.stringify(toolResults);
  assert.equal(await readFile(join(root, 'effects'), 'utf8'), 'effect\n', 'unsafe effect was not repeated');
  assert.equal(await readFile(join(root, 'reads'), 'utf8'), 'read\n', 'completed safe call was reused');
  assert.match(serialised, /INTERRUPTED:/, 'interrupted nested call was reported to resumed codemode');
  assert.doesNotMatch(serialised, /unexpected/, 'interrupted shell was never reported successful');
  assert.match(JSON.stringify(view.entries.at(-1)), /recovery finished/);
  assert.equal(toolResults[0].model[0].details.calls.find(call => call.name === 'host_exec').status, 'error');
  console.log(JSON.stringify({ status: 'PASS', checks: ['actual child SIGKILL', 'native SQLite reopen', 'native codemode nested recovery', 'completed replay-safe result reused once', 'interrupted unsafe host_exec side effect not repeated', 'interruption reported to resumed script'], entries: view.entries.length }));
} finally {
  if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
  if (closed) await closed;
  await killGroup();
  if (harness) await harness.close(context);
  await rm(root, { recursive: true, force: true });
}
