// Host regressions from the 2026-10-24 night review, each on the real module: the sidebar list
// reads only pinned rows after its first call, a failed skill replace keeps the old copy, a
// short connector key cannot rename a tool or break its schema, a message carries at most four
// images in all, and owner copies an older gateway stored are dropped once. Temporary folders,
// a local Pi harness and a fake stdio server only; no network.
import assert from 'node:assert/strict';
import fsp, { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { createSkills, skillRoots } from './skills.mjs';
import { createPluginRegistry } from './plugin-registry.mjs';
import { createConnectors } from './connectors.mjs';
import { createImageStore } from './image-store.mjs';
import { createGateway } from './gateway/core.mjs';
import { startGateway } from './gateway/host.mjs';

const base = await mkdtemp(join(tmpdir(), 'mars-host-regressions-night-'));
const passed = [];
const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple() { throw Error('no model calls in this check'); },
};
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const openHarness = async (name) => Harness.open(await openNodeSqliteStorage(join(base, name)), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
const cleanups = [];

try {
  // ---- 1. The sidebar list reads one page, not every older chat, once pins are known ----
  {
    const harness = await openHarness('conversations.sqlite');
    cleanups.push(() => harness.close?.(context));
    const root = await harness.root(context, { agent });
    let scans = 0;
    // The real harness, counting the scans of all conversations (not one owner's children).
    const counted = new Proxy(harness, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'commit') return typeof value === 'function' ? value.bind(target) : value;
        return (change, ctx) => target.commit((tx) => change(new Proxy(tx, {
          get(t, k) {
            const v = Reflect.get(t, k, t);
            if (k === 'scanConversations') return (query, ...rest) => { if (query?.ownerConversationId === undefined) scans++; return v.call(t, query, ...rest); };
            return typeof v === 'function' ? v.bind(t) : v;
          },
        })), ctx);
      },
    });
    const manager = createConversationManager({ harness: counted, root, context, defaultAgent: agent });
    const pinned = await manager.create({ title: 'Old and pinned' });
    await manager.organise({ conversationId: String(pinned.id), pinned: true });
    for (let n = 0; n < 320; n++) await manager.create({ title: `Newer ${n}` });
    const listed = async () => (await manager.list()).map((row) => row.id);
    assert.ok((await listed()).includes(String(pinned.id)), 'the old pinned chat is listed');
    scans = 0;
    const ids = await listed();
    assert.ok(ids.includes(String(pinned.id)), 'still listed on the next poll');
    assert.ok(scans <= 1, `a poll scans one page, not every older chat: ${scans} scans`);
    await manager.organise({ conversationId: String(pinned.id), pinned: false });
    scans = 0;
    assert.ok(!(await listed()).includes(String(pinned.id)), 'unpinning takes it off the list at once');
    await manager.organise({ conversationId: String(pinned.id), pinned: true });
    assert.ok((await listed()).includes(String(pinned.id)), 'pinning again puts it back at once');
    assert.ok(scans <= 2, `pin changes need no rescan: ${scans} scans`);
    const reopened = createConversationManager({ harness, root, context, defaultAgent: agent });
    assert.ok((await reopened.list()).some((row) => row.id === String(pinned.id) && row.pinned), 'a new manager (a restart) finds the pin');
    passed.push('sidebar poll reads one page');
  }

  // ---- 2. A skill replace that fails keeps the old copy ----
  {
    const home = join(base, 'home'), work = join(base, 'work');
    const skills = createSkills({ roots: skillRoots({ work, env: { HOME: home }, home }), cacheMs: 0 });
    await skills.create({ name: 'keeper', description: 'Use for keeping.', instructions: 'The old, edited version.' });
    const source = join(base, 'skill-source', 'keeper');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '---\nname: keeper\ndescription: Use for the new version.\n---\nThe new version.\n');
    const own = join(work, 'skills');
    // As on the owner's machine: the skills folder is on another disk from the temporary
    // folder (a rename between them is EXDEV), and here that disk is full, so a copy into it
    // fails part way. Node's builtin exports are patched for this block only.
    const inside = (path) => String(path) === own || String(path).startsWith(own + '/');
    const real = { cp: fsp.cp, rename: fsp.rename };
    fsp.rename = async (from, to) => {
      if (inside(from) !== inside(to)) throw Object.assign(Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      return real.rename(from, to);
    };
    fsp.cp = async (from, to, options) => {
      if (!inside(to)) return real.cp(from, to, options);
      await mkdir(to, { recursive: true });
      throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(skills.install({ source }), /ENOSPC/);
    } finally {
      Object.assign(fsp, real);
      syncBuiltinESMExports();
    }
    assert.match(await readFile(join(own, 'keeper', 'SKILL.md'), 'utf8'), /The old, edited version\./, 'the old copy survives a failed replace');
    assert.deepEqual(await readdir(own), ['keeper'], 'a failed replace leaves no partial copy');
    // The swap itself failing (the new copy cannot take the name) puts the old copy back.
    fsp.rename = async (from, to) => {
      if (String(to) === join(own, 'keeper') && String(from).includes('.installing-')) throw Object.assign(Error('EIO: i/o error'), { code: 'EIO' });
      return real.rename(from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(skills.install({ source }), /EIO/);
    } finally {
      Object.assign(fsp, real);
      syncBuiltinESMExports();
    }
    assert.match(await readFile(join(own, 'keeper', 'SKILL.md'), 'utf8'), /The old, edited version\./, 'a failed swap restores the old copy');
    assert.deepEqual(await readdir(own), ['keeper'], 'and leaves nothing hidden behind');
    const installed = await skills.install({ source });
    assert.deepEqual(installed.installed.map((row) => [row.name, row.replaced]), [['keeper', true]]);
    assert.match(await readFile(join(own, 'keeper', 'SKILL.md'), 'utf8'), /The new version\./, 'a working replace installs the new copy');
    assert.deepEqual((await readdir(own)).sort(), ['keeper'], 'no hidden staging or backup folder is left behind');
    passed.push('failed skill replace keeps the old copy');
  }

  // ---- 3. A short connector key does not rename a tool or break its schema ----
  {
    const fake = join(base, 'fake-mcp.mjs');
    await writeFile(fake, `import { createInterface } from "node:readline";
const tools = JSON.parse(process.argv[2]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "night", version: "1" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    const ok = (name === "run_tests" && typeof args.test_name === "string") || (name === "sized" && typeof args.q === "string");
    return send({ jsonrpc: "2.0", id: message.id, result: ok ? { content: [{ type: "text", text: "matched" }] } : { isError: true, content: [{ type: "text", text: "unknown call" }] } });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
`);
    const dataDir = join(base, 'connectors');
    const plugins = await createPluginRegistry({ root: join(dataDir, 'plugin-settings') });
    const manager = createConnectors({ dataDir, registry: plugins.registry, work: base, env: { PATH: process.env.PATH } });
    cleanups.push(() => manager.close());
    await manager.boot();
    const tool = (name) => plugins.registry.snapshot().tools().find(({ tool: item }) => item.name === name)?.tool;
    const server = (tools) => ({ command: process.execPath, args: [fake, JSON.stringify(tools)] });

    await manager.add({ name: 'Tester', ...server([{ name: 'run_tests', description: 'Runs the test suite.', inputSchema: { type: 'object', properties: { test_name: { type: 'string', description: 'Which test' } }, required: ['test_name'] } }]), auth: { type: 'key', env: 'FAKE_TOKEN' }, key: 'test' });
    assert.equal((await manager.connect('tester')).connector.status, 'connected');
    const runTests = tool('conn_tester_run_tests');
    assert.ok(runTests, 'the tool is installed under its own name');
    assert.deepEqual(Object.keys(runTests.parameters.properties ?? {}), ['test_name'], 'property names are kept: ' + JSON.stringify(runTests.parameters));
    assert.deepEqual(runTests.parameters.required, ['test_name']);
    assert.equal((await runTests.execute({ test_name: 'all' }, {}, {})).structuredOutput.text, 'matched', 'the call reaches the server under the tool\'s real name');
    assert.match(runTests.description.split('\n')[0], /^Runs the \[redacted\] suite\.$/, 'descriptions are still scrubbed of the key');

    await manager.add({ name: 'Sizer', ...server([{ name: 'sized', inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 40960, description: 'Up to 40960 characters' } }, required: ['q'] } }]), auth: { type: 'key', env: 'FAKE_TOKEN' }, key: '4096' });
    assert.equal((await manager.connect('sizer')).connector.status, 'connected');
    const sized = tool('conn_sizer_sized');
    assert.equal(sized.parameters.properties?.q?.maxLength, 40960, 'a number that contains the key stays a number: ' + JSON.stringify(sized.parameters));
    assert.equal(sized.parameters.properties.q.description, 'Up to [redacted]0 characters');
    assert.equal((await sized.execute({ q: 'x' }, {}, {})).structuredOutput.text, 'matched');
    passed.push('short connector key keeps tool and property names');
  }

  // ---- 4. A message carries at most four images, placed and unplaced together ----
  {
    const images = createImageStore({ root: join(base, 'images') });
    const make = async (r) => (await images.add(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 2, b: 3 } } }).png().toBuffer(), { mimeType: 'image/png', name: `${r}.png` })).id;
    const ids = [await make(10), await make(20), await make(30), await make(40)];
    const chip = (id) => `:image[Image 1]{name=${id}}`;
    const count = (content) => content.content.filter((block) => block.type === 'image').length;
    const each = (content) => ids.filter((id) => content.content.some((block) => block.type === 'text' && block.text.startsWith(`Attachment ${id}:`)));
    let content = await images.content(ids, [1, 2, 3, 4].map(() => chip(ids[0])).join(' and '));
    assert.equal(count(content), 4, 'four attached, one chip repeated four times: four images, got ' + count(content));
    assert.equal(content.attachments.length, 4);
    assert.deepEqual(each(content), ids, 'every attached image is still sent');
    content = await images.content(ids.slice(0, 2), [1, 2, 3, 4, 5].map(() => chip(ids[0])).join(' '));
    assert.equal(count(content), 4, 'two attached, one chip five times: four images, got ' + count(content));
    assert.deepEqual(each(content), ids.slice(0, 2), 'the unplaced image keeps its slot');
    content = await images.content([ids[0]], chip(ids[0]) + ' then ' + chip(ids[0]));
    assert.equal(count(content), 2, 'a repeated chip is still placed twice when there is room');
    passed.push('at most four images per message');
  }

  // ---- 5. Owner copies an older gateway stored are dropped once ----
  {
    const OWNER = '7770001', FRIEND = '7770002';
    let harness = await openHarness('gateway.sqlite');
    const open = async () => {
      const root = await harness.root(context, { agent });
      return createConversationManager({ harness, root, context, defaultAgent: agent });
    };
    let conversations = await open();
    // A host before 2026-10-24: configured owners and the API owner were stored as approved.
    const old = createGateway({ harness, conversations, context });
    await old.allow('api', 'owner');
    await old.allow('telegram', OWNER);
    await old.allow('telegram', FRIEND); // approved through a pairing
    await old.close();
    const boot = async (env) => {
      const { gateway } = await startGateway({ harness, conversations, context, env, log: () => {} });
      const status = await gateway.status();
      await gateway.close();
      return status;
    };
    let status = await boot({ MARS_TELEGRAM_OWNER: OWNER });
    assert.deepEqual(status.allowed.telegram, [FRIEND], 'the stored copy of a configured owner is dropped, the approval kept');
    assert.ok(!(status.allowed.api ?? []).includes('owner'), 'the stored API owner is dropped');
    assert.deepEqual(status.owners.telegram, [OWNER]);
    await harness.close?.(context);
    harness = await openHarness('gateway.sqlite');
    conversations = await open();
    status = await boot({});
    assert.ok(!(status.allowed.telegram ?? []).includes(OWNER) && !(status.owners.telegram ?? []).includes(OWNER), 'taken out of the configuration, the owner is no longer allowed');
    assert.deepEqual(status.allowed.telegram, [FRIEND]);
    // Once only: a later approval of a configured id is never undone.
    const later = createGateway({ harness, conversations, context });
    await later.allow('telegram', OWNER);
    await later.close();
    status = await boot({ MARS_TELEGRAM_OWNER: OWNER });
    assert.deepEqual(status.allowed.telegram, [FRIEND, OWNER], 'the cleanup runs once');
    await harness.close?.(context);
    passed.push('stored gateway owners dropped once');
  }
  console.log('PASS host regressions night: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
  await rm(base, { recursive: true, force: true });
}
