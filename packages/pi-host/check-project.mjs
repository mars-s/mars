// Project instructions and memory on a real Pi harness with a scripted model that records its
// system prompt (no provider is called): the repository is found from the first tool call that
// names a path in a git repo, its AGENTS.md and CLAUDE.md enter the prompt, project_open switches,
// and memory notes are added, removed and shown in every conversation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ProjectDoc, createProjectExtension, createProjects, pathOfCall } from './project.mjs';
import { MEMORY_MAX, createMemory, createMemoryExtension } from './memory.mjs';

const run = promisify(execFile);
const prompts = [];
const latestProject = { value: '' };
const textOf = (m) => (typeof m?.content === 'string' ? m.content : m?.content?.find?.((c) => c.type === 'text')?.text ?? '');
const models = {
  getModels: () => [{ id: 'fake', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    // Pi sends sections as system messages, adding a new one when a section changes.
    // Each system message carries the sections that changed, by key.
    const current = {};
    for (const m of input.messages) if (m.role === 'system') Object.assign(current, m.sections ?? {});
    prompts.push(Object.values(current).filter(Boolean).join('\n'));
    latestProject.value = current.project ?? '';
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const text = textOf(last);
    if (last?.role === 'user' && text.startsWith('CALL ')) {
      const [, name, ...json] = text.split(' ');
      message.content = [{ type: 'toolCall', id: `call-${prompts.length}`, name, arguments: JSON.parse(json.join(' ')) }];
      message.stopReason = 'toolUse';
    }
    setTimeout(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }, 5);
    return stream;
  },
};
const dir = await mkdtemp(join(tmpdir(), 'mars-project-'));
const work = join(dir, 'work');
const repo = join(dir, 'site');
const other = join(dir, 'other');
await mkdir(join(repo, 'src'), { recursive: true });
await mkdir(other, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(join(repo, 'AGENTS.md'), 'Use pnpm, never npm.');
await writeFile(join(repo, 'CLAUDE.md'), 'Run the linter before committing.');
await writeFile(join(repo, 'src/app.js'), 'x');
await writeFile(join(other, 'AGENTS.md'), 'Other repo rules.');
for (const path of [repo, other]) await run('git', ['init', '-q', path]);
// A stand-in for host_exec: any tool with a cwd or command argument.
const shell = defineExtension({ name: 'fake-shell', tools: [defineTool({ name: 'host_exec', description: 'Run a command.', parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) }), deferred: false, replay: 'safe', execute: async () => ({ output: [{ type: 'text', text: 'ran' }] }) })] });
let late = {};
const projects = createProjects({ harness: () => late.harness, work, context });
const memory = createMemory({ work });
const project = createProjectExtension({ projects });
const memoryExtension = createMemoryExtension({ memory });
const registry = createRegistry();
for (const extension of [shell, project, memoryExtension]) registry.install(extension);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'db.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
late.harness = harness;
const tools = [...shell.tools, ...project.tools, ...memoryExtension.tools];
const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'fake' }, modelTools: tools } });
const say = async (conversation, text) => (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
const until = async (test, label) => { for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('timed out: ' + label); };

try {
  assert.equal(pathOfCall('host_exec', { command: 'cd /tmp/x && ls' }, work), '/tmp/x');
  assert.equal(pathOfCall('host_exec', { command: "cd 'a b'; ls" }, '/w'), '/w/a b');
  assert.equal(pathOfCall('host_exec', { cwd: 'site' }, '/w'), '/w/site');
  assert.equal(pathOfCall('read', { path: '~/x.md' }, '/w').endsWith('/x.md'), true);
  assert.equal(pathOfCall('web_fetch', { url: 'https://x' }, '/w'), '');

  // No project yet: no Project section.
  await say(root, 'hello');
  assert.ok(!prompts.at(-1).includes('## Project'), 'no project section before any repository is used');

  // The first command in a repository sets the project; its instructions reach the next request.
  await say(root, `CALL host_exec ${JSON.stringify({ command: `cd ${join(repo, 'src')} && ls` })}`);
  await until(async () => (await harness.snapshot(ProjectDoc, root.id, context))?.root, 'project noticed');
  const real = (await run('git', ['-C', repo, 'rev-parse', '--show-toplevel'])).stdout.trim();
  assert.equal((await harness.snapshot(ProjectDoc, root.id, context)).root, real);
  await say(root, 'next');
  assert.match(prompts.at(-1), /## Project[\s\S]*Use pnpm, never npm\.[\s\S]*Run the linter before committing\./);

  // A later command elsewhere never switches it; project_open does.
  await say(root, `CALL host_exec ${JSON.stringify({ cwd: other, command: 'ls' })}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await harness.snapshot(ProjectDoc, root.id, context)).root, real, 'automatic detection never switches');
  await say(root, `CALL project_open ${JSON.stringify({ path: other })}`);
  await say(root, 'after switch');
  assert.match(latestProject.value, /Other repo rules\./);
  assert.ok(!latestProject.value.includes('Use pnpm'), 'the current Project section is the new repository');
  await assert.rejects(projects.open(root.id, join(dir, 'missing')), /not a folder/);

  // Memory: add, show in a new conversation, remove, bounds.
  const added = await memory.update({ add: ['Prefer Australian English.', '  Deploy once at the end.  ', 'Prefer Australian English.'] });
  assert.deepEqual(added.notes, ['Prefer Australian English.', 'Deploy once at the end.']);
  const fresh = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'openai', modelId: 'fake' }, modelTools: tools } }, context);
  await say(fresh, 'hi');
  assert.match(prompts.at(-1), /## Memory[\s\S]*- Prefer Australian English\.[\s\S]*- Deploy once at the end\./);
  assert.ok(!prompts.at(-1).includes('## Project'), 'a new conversation starts without a project');
  await say(fresh, `CALL memory_update ${JSON.stringify({ remove: ['prefer australian english.', 'not there'] })}`);
  assert.deepEqual(await memory.notes(), ['Deploy once at the end.']);
  assert.match(await readFile(memory.file, 'utf8'), /^# Memory/);
  await assert.rejects(memory.update({ add: Array.from({ length: 20 }, (_, n) => 'x'.repeat(480) + n) }), new RegExp(`limit is ${MEMORY_MAX}`));
  assert.deepEqual(await memory.notes(), ['Deploy once at the end.'], 'a refused update changes nothing');
  await memory.update({ remove: ['Deploy once at the end.'] });
  await say(fresh, 'empty');
  assert.ok(!prompts.at(-1).includes('## Memory'), 'no Memory section when empty');
  console.log('PASS project and memory: path of call, no section before a repo, first repo command sets it, AGENTS.md and CLAUDE.md in the prompt, never auto-switches, project_open switches, refusals, memory add dedupe, shown in new conversations, remove case-insensitive, bounded, empty means no section');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
