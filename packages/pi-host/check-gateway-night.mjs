// Gateway night fixes (docs/GATEWAY.md): the chunker always finishes and keeps code and
// emoji whole, Telegram group commands that name the bot, removing an approved sender,
// host configured owners that stop when taken out of the configuration, and answers that
// reach the chat that asked after it moved to another conversation. Real Pi harness with a
// scripted model and a fake Telegram; no provider or platform is called.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { GatewayDoc, createGateway } from './gateway/core.mjs';
import { gatewayRoute } from './gateway/host.mjs';
import { createApiAdapter } from './gateway/adapters/api.mjs';
import { createTelegramAdapter } from './gateway/adapters/telegram.mjs';
import { fakeTelegram } from './gateway/fakes.mjs';
import { startHost } from './workbench/test-host.mjs';

setTimeout(() => { console.error('check-gateway-night: timed out after 150 s'); process.exit(1); }, 150000).unref();
const until = async (predicate, what, ms = 6000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// 1. The chunker, in a worker with a memory cap and a time limit, so a chunker that never
// finishes fails this check instead of hanging it (it is synchronous, and in the host it
// would stop everything).
const chunkCases = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.url).then(({ chunkText }) => {
    const out = {};
    out.longFence4096 = chunkText('\`\`\`' + 'word '.repeat(1200), 4096);
    out.longFence2000 = chunkText('\`\`\`' + 'word '.repeat(600), 2000);
    out.longFenceNoSpaces = chunkText('\`\`\`' + 'x'.repeat(6000) + '\\nmore\\n\`\`\`', 2000);
    out.longMarker = chunkText('\`'.repeat(5000) + '\\ncode\\n' + '\`'.repeat(5000), 2000);
    out.python = chunkText('def f():\\n' + '    x = 1\\n'.repeat(12) + '    return 3\\n', 100);
    out.emoji = [40, 41, 42, 43, 100].flatMap((limit) => [chunkText('😀'.repeat(100), limit), chunkText('a' + '😀'.repeat(100), limit)]);
    // Seeded random text built from the pieces that trouble a chunker.
    let seed = 7;
    const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pieces = ['\`\`\`', '~~~', '\`\`\`js', '\`\`\`python', '\\n', '\\n\\n', ' ', '    ', 'word', 'longerword', '.', '😀', '\`', '\`\`\`' + 'q'.repeat(90)];
    out.fuzz = [];
    for (let n = 0; n < 400; n++) {
      const limit = [40, 41, 57, 100, 333][random(5)];
      let text = '';
      const length = random(3000);
      while (text.length < length) text += pieces[random(pieces.length)];
      out.fuzz.push({ limit, text, chunks: chunkText(text, limit) });
    }
    parentPort.postMessage(out);
  });
`;
const chunked = await new Promise((resolve) => {
  const worker = new Worker(chunkCases, { eval: true, workerData: { url: new URL('./gateway/chunk.mjs', import.meta.url).href }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
  const timer = setTimeout(() => { worker.terminate(); resolve({ error: 'did not finish in 10 s' }); }, 10000);
  worker.once('message', (value) => { clearTimeout(timer); worker.terminate(); resolve(value); });
  worker.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
});
assert.equal(chunked.error, undefined, 'the chunker finishes on a long fenced line: ' + chunked.error);
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const solid = (text) => text.replace(/\s+/g, '');
/** Every non-space character of `text` appears in `chunks`, in order. */
const keepsText = (text, chunks) => {
  const all = solid(chunks.join('\n'));
  let at = 0;
  for (const char of solid(text)) { at = all.indexOf(char, at); if (at < 0) return false; at += char.length; }
  return true;
};
for (const [name, limit, text] of [['longFence4096', 4096, '```' + 'word '.repeat(1200)], ['longFence2000', 2000, '```' + 'word '.repeat(600)]]) {
  const chunks = chunked[name];
  assert.equal(chunks.length, 2, name + ': about 6 KB or 3 KB of text gives 2 chunks, not a flood of near copies');
  assert.ok(chunks.every((c) => c.length <= limit), name + ': chunks fit the limit');
  assert.ok(chunks.every((c) => (c.match(/^```/gm) ?? []).length % 2 === 0 || c === chunks.at(-1)), name + ': fences closed between chunks');
  assert.ok(keepsText(text, chunks), name + ': no text lost');
}
assert.ok(chunked.longFenceNoSpaces.every((c) => c.length <= 2000) && chunked.longFenceNoSpaces.length <= 4, 'a long fence line without spaces is cut hard, a few chunks');
assert.ok(chunked.longMarker.every((c) => c.length <= 2000) && keepsText('`'.repeat(5000) + 'code' + '`'.repeat(5000), chunked.longMarker), 'a marker longer than any fence is plain text');
assert.match(chunked.python[1], /^ {4}x = 1/, 'a later chunk keeps the indentation of its first line');
assert.ok(chunked.python.join('\n').includes('\n    return 3'), 'indented code is kept as written');
assert.ok(chunked.emoji.flat().every((c) => !loneSurrogate.test(c)), 'a hard cut never splits an emoji');
assert.ok(chunked.emoji.every((chunks) => chunks.join('').replace(/^a/, '') === '😀'.repeat(100)), 'every emoji arrives');
for (const { limit, text, chunks } of chunked.fuzz) {
  const label = JSON.stringify({ limit, text: text.slice(0, 120) });
  assert.ok(chunks.every((c) => c.length <= limit && c.trim()), 'chunks fit and are never empty: ' + label);
  assert.ok(chunks.every((c) => !loneSurrogate.test(c)) || loneSurrogate.test(text), 'no split emoji: ' + label);
  assert.ok(keepsText(text, chunks), 'no text lost: ' + label);
}

// The rest runs on a real harness: a scripted model that echoes, "SLOW <ms> <text>" late.
const seen = [];
const models = {
  getModels: () => [{ id: 'gpt-6-luna', provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 1000 }],
  getModel(provider, id) { return this.getModels().find((m) => m.id === id && m.provider === provider); },
  streamSimple(model, input) {
    const stream = new AssistantMessageEventStream();
    const last = input.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : last?.content?.find?.((c) => c.type === 'text')?.text ?? '';
    seen.push(text);
    let reply = `echo: ${text}`, delay = 5;
    const slow = text.match(/^SLOW (\d+) (.*)$/s);
    if (slow) { delay = Number(slow[1]); reply = `slow: ${slow[2]}`; }
    const message = { role: 'assistant', content: [{ type: 'text', text: reply }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    setTimeout(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }, delay);
    return stream;
  },
};
const dir = await mkdtemp(join(tmpdir(), 'mars-gateway-night-'));
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const TG_TOKEN = '123456:' + 'N'.repeat(30);
const OWNER = '6660001', FRIEND = '6660002', GROUP = '-1006660';
async function open() {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'pi.sqlite')), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, context);
  const root = await harness.root(context, { agent });
  const conversations = createConversationManager({ harness, root, context, defaultAgent: agent });
  harness.resume();
  return { harness, conversations };
}
const telegram = await fakeTelegram({ token: TG_TOKEN });
let host = await open();
let gateway, api;
async function boot(owners) {
  gateway = createGateway({ harness: host.harness, conversations: host.conversations, context, backoff: { firstMs: 20, maxMs: 100 } });
  api = createApiAdapter({ store: { harness: host.harness, context } });
  gateway.addAdapter(api);
  gateway.addAdapter(createTelegramAdapter({ token: TG_TOKEN, baseUrl: telegram.baseUrl, pollTimeoutSeconds: 1 }));
  gateway.setOwners('api', ['owner']);
  gateway.setOwners('telegram', owners);
  await gateway.resume();
  await until(async () => (await gateway.status()).adapters.every((a) => a.state === 'running') && api.health().state === 'running', 'adapters running');
}
async function restart(owners) {
  await gateway.close();
  await host.harness.close(context);
  host = await open();
  await boot(owners);
}
const sentTo = (chat) => telegram.sent.filter((m) => String(m.chat.id) === String(chat)).map((m) => m.text);
const mailbox = async (chatId) => (await api.read({ chatId })).items.map((item) => item.text);
await boot([OWNER]);

try {
  // 2. Telegram group commands name the bot: "/status@mars_test_bot".
  telegram.message({ from: OWNER, chat: GROUP, text: '/status@mars_test_bot' });
  const status = await until(() => sentTo(GROUP)[0], 'reply to /status@bot in a group');
  assert.match(status, /has no conversation yet/, 'a command naming this bot runs: ' + status);
  telegram.message({ from: OWNER, chat: GROUP, text: '/steer@Mars_Test_Bot hello group' });
  await until(() => sentTo(GROUP).includes('echo: hello group'), 'steer naming the bot answered');
  assert.ok(seen.includes('hello group') && !seen.some((t) => t.includes('@')), 'the bot name is not sent to the model');
  telegram.message({ from: OWNER, chat: GROUP, text: '/status@some_other_bot' });
  telegram.message({ from: OWNER, chat: GROUP, text: '/help@mars_test_bot' });
  await until(() => sentTo(GROUP).some((t) => t.startsWith('Commands:')), '/help@bot answered');
  assert.ok(!sentTo(GROUP).some((t) => t.startsWith('Unknown command')), "another bot's command gets no reply from Mars");

  // 3. An answer reaches the chat that asked, even after /new moved the chat on.
  await api.post({ chatId: 'phone', eventId: 'slow-1', text: 'SLOW 700 the long question' });
  await api.post({ chatId: 'phone', eventId: 'new-1', text: '/new Something else' });
  await until(async () => (await mailbox('phone')).includes('slow: the long question'), 'answer delivered after /new');
  const doc = await host.harness.snapshot(GatewayDoc, context);
  assert.deepEqual(doc.origins, {}, 'the asking chat is forgotten once the answer is queued');
  // ... and across a restart: the asking chat is stored with the watched submission.
  await api.post({ chatId: 'phone', eventId: 'slow-2', text: 'SLOW 900 across a restart' });
  await api.post({ chatId: 'phone', eventId: 'switch-1', text: '/new Third' });
  await until(async () => (await mailbox('phone')).some((t) => t.startsWith('Started a new conversation')), '/new reply');
  await restart([OWNER]);
  await until(async () => (await mailbox('phone')).includes('slow: across a restart'), 'answer delivered after /new and a restart', 8000);
  assert.equal((await mailbox('phone')).filter((t) => t === 'slow: across a restart').length, 1, 'once');

  // 4. Owners from the host configuration are allowed while configured, never stored.
  telegram.message({ from: OWNER, text: 'owner hello' });
  await until(() => sentTo(OWNER).includes('echo: owner hello'), 'configured owner answered');
  let state = await gateway.status();
  assert.deepEqual(state.owners.telegram, [OWNER], 'status lists the configured owners');
  assert.ok(!(state.allowed.telegram ?? []).includes(OWNER), 'a configured owner is not written to the approved list');

  // 5. Approve a friend, then remove them: their next message gets a new code and never reaches Pi.
  telegram.message({ from: FRIEND, text: 'let me in' });
  const pairing = await until(async () => (await gateway.status()).pairings.find((p) => p.sender === FRIEND), 'pairing');
  await gateway.decidePairing(pairing.code, true);
  telegram.message({ from: FRIEND, text: 'friend first' });
  await until(() => sentTo(FRIEND).includes('echo: friend first'), 'approved friend answered');
  const removed = await gateway.disallow('telegram', FRIEND);
  assert.deepEqual(removed, { channel: 'telegram', sender: FRIEND, removed: true, configured: false });
  assert.equal((await gateway.disallow('telegram', FRIEND)).removed, false, 'removing twice is harmless');
  state = await gateway.status();
  assert.ok(!(state.allowed.telegram ?? []).includes(FRIEND), 'gone from the approved list');
  assert.ok(state.audit.some((a) => a.decision === 'removed' && a.sender === FRIEND), 'the removal is audited');
  telegram.message({ from: FRIEND, text: 'friend after removal' });
  await until(() => sentTo(FRIEND).some((t, i, all) => i > 0 && /Pairing code/.test(t) && all.slice(0, i).includes('echo: friend first')), 'a new pairing code after removal');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!seen.includes('friend after removal'), "a removed sender's text never reaches Pi");

  // 6. Through the owner route: bad input is refused, a removal is reported.
  const calls = [];
  const route = async (body) => {
    const res = {};
    await gatewayRoute({ req: { method: 'POST' }, url: new URL('http://127.0.0.1/api/gateway/allow/delete'), res, send: (r, status, value) => calls.push({ status, value }), jsonBody: async () => body, gateway, api, available: {} });
    return calls.at(-1);
  };
  await assert.rejects(route({ channel: 'telegram' }), (error) => error.status === 400, 'a sender is required');
  await gateway.allow('telegram', OWNER); // as hosts before this change stored configured owners
  const legacy = await route({ channel: 'telegram', sender: OWNER });
  assert.deepEqual(legacy, { status: 200, value: { channel: 'telegram', sender: OWNER, removed: true, configured: true } }, 'a stored copy of a configured owner can be removed');
  telegram.message({ from: OWNER, text: 'still the owner' });
  await until(() => sentTo(OWNER).includes('echo: still the owner'), 'the configured owner is still allowed by the configuration');

  // 7. Taken out of the configuration: after a restart the old owner is a stranger.
  await restart([]);
  telegram.message({ from: OWNER, text: 'after leaving the configuration' });
  await until(() => sentTo(OWNER).some((t) => /Pairing code/.test(t)), 'a former configured owner gets a pairing code');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!seen.includes('after leaving the configuration'), 'and their text never reaches Pi');
} finally {
  await gateway.close().catch(() => {});
  await host.harness.close(context).catch(() => {});
}

// 8. The real host: the route needs the owner token, and removing an id from
// MARS_TELEGRAM_OWNER stops it after a restart.
const env = { MARS_GATEWAY_FAKE: '1', MARS_GATEWAY_TELEGRAM: '1', MARS_TELEGRAM_TOKEN: TG_TOKEN, MARS_TELEGRAM_API: telegram.baseUrl };
let real = await startHost({ ...env, MARS_TELEGRAM_OWNER: '7710001' });
try {
  assert.equal((await real.request('/api/gateway/allow/delete', { method: 'POST', body: { channel: 'telegram', sender: '7710001' }, auth: false })).status, 401, 'owner auth required');
  const first = (await real.request('/api/gateway')).json;
  assert.deepEqual(first.owners.telegram, ['7710001'], 'configured owner listed');
  assert.ok(!(first.allowed.telegram ?? []).includes('7710001'), 'and not stored');
  const refused = await real.request('/api/gateway/allow/delete', { method: 'POST', body: { channel: 'telegram' } });
  assert.equal(refused.status, 400);
  const done = await real.request('/api/gateway/allow/delete', { method: 'POST', body: { channel: 'telegram', sender: '7710001' } });
  assert.deepEqual(done.json, { channel: 'telegram', sender: '7710001', removed: false, configured: true }, 'a configured owner is removed in the configuration, not here');
  await real.stop();
  real = await startHost(env, real);
  await until(async () => (await real.request('/api/gateway')).json.adapters.find((a) => a.channel === 'telegram')?.state === 'running', 'telegram running', 10000);
  telegram.message({ from: '7710001', text: 'am I still in?' });
  const pending = await until(async () => (await real.request('/api/gateway')).json.pairings.find((p) => p.sender === '7710001'), 'former owner asked to pair', 10000);
  assert.ok(pending.code, 'removing an id from MARS_TELEGRAM_OWNER stops it after a restart');
} finally {
  await real.stop().catch(() => {});
  await telegram.close();
}
console.log('PASS gateway night: the chunker finishes on long fenced lines and keeps indentation and emoji, group commands naming the bot, answers reach the asking chat after /new and a restart, configured owners allowed only while configured, approved senders removable through the owner route');
process.exit(0);
