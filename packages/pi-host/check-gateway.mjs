// Gateway end to end on a real Pi harness (docs/GATEWAY.md "Acceptance"), with a scripted
// model and fake Telegram and Discord servers. No provider or platform is called.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, InboxDoc, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createConversationManager } from './conversations.mjs';
import { ChannelDoc, GatewayDoc, createGateway, routeKey } from './gateway/core.mjs';
import { chunkText } from './gateway/chunk.mjs';
import { createApiAdapter } from './gateway/adapters/api.mjs';
import { createTelegramAdapter } from './gateway/adapters/telegram.mjs';
import { createDiscordAdapter } from './gateway/adapters/discord.mjs';
import { fakeDiscord, fakeTelegram } from './gateway/fakes.mjs';

// Scripted model: "SLOW <ms> <text>" answers after a delay, "LONG <n>" answers with n
// characters, anything else is echoed. Every request is recorded.
const seen = [];
const gates = new Map();
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
    const long = text.match(/^LONG (\d+)$/);
    if (long) reply = ('Paragraph of words. '.repeat(30) + '\n\n').repeat(Math.ceil(Number(long[1]) / 640)).slice(0, Number(long[1]));
    const message = { role: 'assistant', content: [{ type: 'text', text: reply }], api: 'fake', provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const finish = () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); };
    const gate = gates.get(text);
    if (gate) gate.then(finish); else setTimeout(finish, delay);
    return stream;
  },
};
const until = async (predicate, what, ms = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

setTimeout(() => { console.error('check-gateway: timed out after 90 s'); process.exit(1); }, 90000).unref();
const dir = await mkdtemp(join(tmpdir(), 'mars-gateway-'));
const agent = { model: { provider: 'openai', modelId: 'gpt-6-luna' } };
const TG_TOKEN = '123456:' + 'A'.repeat(30);
const DC_TOKEN = 'D'.repeat(24) + '.' + 'x'.repeat(6) + '.' + 'y'.repeat(38);
const OWNER_TG = '5550001', STRANGER_TG = '5550002', OWNER_DC = '400000000000000001';

async function open() {
  const registry = createRegistry();
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'pi.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
  const root = await harness.root(context, { agent });
  const conversations = createConversationManager({ harness, root, context, defaultAgent: agent });
  harness.resume();
  return { harness, conversations };
}

const telegram = await fakeTelegram({ token: TG_TOKEN });
const discord = await fakeDiscord({ token: DC_TOKEN });
let host = await open();
const workersOf = async (id) => (String(id) === String(statusWorkersFor) ? [{ title: 'Review a.ts', status: 'running' }, { title: 'Done job', status: 'completed' }] : []);
let statusWorkersFor = null;
let gateway = createGateway({ harness: host.harness, conversations: host.conversations, context, backoff: { firstMs: 20, maxMs: 100 }, workersOf, typingEveryMs: 100 });
const api = createApiAdapter();
gateway.addAdapter(api);
gateway.addAdapter(createTelegramAdapter({ token: TG_TOKEN, baseUrl: telegram.baseUrl, pollTimeoutSeconds: 1 }));
gateway.addAdapter(createDiscordAdapter({ token: DC_TOKEN, apiUrl: discord.apiUrl }));
await gateway.allow('telegram', OWNER_TG);
await gateway.allow('discord', OWNER_DC);
await gateway.allow('api', 'owner');
const sentTo = (chat) => telegram.sent.filter((m) => String(m.chat.id) === String(chat)).map((m) => m.text);

try {
  // Route keys: one per chat, never confusable.
  assert.equal(routeKey({ channel: 'telegram', account: '9', chat: { id: '5', type: 'dm' } }), 'telegram:9:dm:5');
  assert.equal(routeKey({ channel: 'discord', account: '9', chat: { id: '5', type: 'group' }, thread: '7' }), 'discord:9:group:5:thread:7');
  assert.throws(() => routeKey({ channel: 'telegram', account: '9', chat: { id: '5:x', type: 'dm' } }), /chatId/);

  // Chunker: fits the limit, keeps fences balanced, keeps every word.
  const fenced = 'Intro.\n\n```js\n' + Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```\nEnd.';
  const parts = chunkText(fenced, 200);
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 200), 'chunks fit the limit');
  assert.ok(parts.every((p) => (p.match(/^```/gm) ?? []).length % 2 === 0), 'no chunk leaves a code fence open');
  assert.equal(parts.join('\n').replace(/\n```\n```js\n/g, '\n').replace(/\s+/g, ''), fenced.replace(/\s+/g, ''), 'no text lost');

  // 1. Start from Telegram: a new conversation, bound and badged, answered back in Telegram.
  telegram.message({ from: OWNER_TG, text: 'Plan the garden' });
  await until(() => sentTo(OWNER_TG).includes('echo: Plan the garden'), 'telegram reply');
  const doc = await host.harness.snapshot(GatewayDoc, context);
  const route = `telegram:999:dm:${OWNER_TG}`;
  const conversationId = doc.bindings[route];
  assert.ok(conversationId, 'the chat is bound to a conversation');
  const row = (await host.conversations.list()).find((r) => r.id === conversationId);
  assert.equal(row.title, 'Plan the garden', 'it is an ordinary Recents conversation titled from the message');
  assert.equal((await host.harness.snapshot(ChannelDoc, Number(conversationId), context)).channel, 'telegram', 'it carries its channel for the badge');
  assert.ok(telegram.actions.some((a) => a.action === 'typing'), 'Telegram shows typing while it answers');

  // 2. Continue from the web UI (the same conversation, by id), and the reply reaches Telegram too.
  const web = await host.conversations.resolve(conversationId);
  const webSubmission = await web.submit({ type: 'input', content: 'From the web', requestId: 'web-1' }, context);
  await gateway.watchSubmission(conversationId, webSubmission.id);
  await until(() => sentTo(OWNER_TG).includes('echo: From the web'), 'web reply mirrored to Telegram');

  // 3. Continue again from Telegram: the model sees the whole conversation.
  telegram.message({ from: OWNER_TG, text: 'Back on my phone' });
  await until(() => sentTo(OWNER_TG).includes('echo: Back on my phone'), 'second telegram reply');
  const transcript = (await host.conversations.state(conversationId)).entries.filter((e) => e.kind === 'mars.user').map((e) => e.model?.[0]?.content);
  assert.deepEqual(transcript.map((c) => (typeof c === 'string' ? c : c?.[0]?.text)), ['Plan the garden', 'Back on my phone'], 'Telegram messages are in the transcript');
  assert.equal((await host.conversations.state(conversationId)).entries.filter((e) => e.kind === 'pi.user').length, 1, 'the web message is there too');

  // 4. Duplicate delivery: the same update again submits nothing.
  const before = seen.length;
  const dupId = telegram.message({ from: OWNER_TG, text: 'Only once please' });
  await until(() => sentTo(OWNER_TG).includes('echo: Only once please'), 'reply before duplicate');
  telegram.redeliver(dupId);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(seen.filter((t) => t === 'Only once please').length, 1, 'a redelivered update reaches the model once');
  assert.equal(sentTo(OWNER_TG).filter((t) => t === 'echo: Only once please').length, 1, 'and is answered once');
  assert.ok(seen.length >= before + 1);

  // 5. Busy conversation: a second message queues behind the first; another conversation is untouched.
  let release;
  gates.set('Hold on', new Promise((resolve) => { release = resolve; }));
  telegram.message({ from: OWNER_TG, text: 'Hold on' });
  await until(async () => (await host.harness.snapshot(LiveDoc, Number(conversationId), context))?.run, 'first run started');
  telegram.message({ from: OWNER_TG, text: 'Queued behind' });
  const other = await api.post({ chatId: 'laptop', eventId: 'e1', text: 'Separate work' });
  await until(() => api.read({ chatId: 'laptop' }).items.some((m) => m.text === 'echo: Separate work'), 'other conversation answered while the first is busy');
  assert.notEqual(other.conversationId, conversationId, 'the API chat has its own conversation');
  assert.ok(!seen.includes('Queued behind'), 'the queued message waits for the busy run');
  const inbox = await until(async () => (await host.harness.snapshot(InboxDoc, Number(conversationId), context))?.items?.length && (await host.harness.snapshot(InboxDoc, Number(conversationId), context)), 'queued in the inbox');
  assert.deepEqual(inbox.items.map((item) => item.mode), ['followUp'], 'a chat message to a busy conversation is a follow-up, never a steer');
  const typingBefore = telegram.actions.length;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(telegram.actions.length - typingBefore >= 3, 'typing is refreshed while a long answer runs');
  release();
  await until(() => sentTo(OWNER_TG).includes('echo: Queued behind'), 'queued message answered after');
  await gateway.settle();
  const typingAfter = telegram.actions.length;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(telegram.actions.length, typingAfter, 'and stops once answered');
  const order = sentTo(OWNER_TG);
  assert.ok(order.indexOf('echo: Hold on') < order.indexOf('echo: Queued behind'), 'in order');

  // 5b. /steer joins a running answer. If Pi answers a steer and a queued message in one
  // run, both share one answer, which reaches the chat once.
  let releaseSteer;
  gates.set('Hold two', new Promise((resolve) => { releaseSteer = resolve; }));
  telegram.message({ from: OWNER_TG, text: 'Hold two' });
  await until(async () => (await host.harness.snapshot(LiveDoc, Number(conversationId), context))?.run, 'second gated run started');
  telegram.message({ from: OWNER_TG, text: 'and one more' });
  telegram.message({ from: OWNER_TG, text: '/steer use metric units' });
  const steered = await until(async () => {
    const items = (await host.harness.snapshot(InboxDoc, Number(conversationId), context))?.items ?? [];
    return items.length === 2 && items;
  }, '/steer queued');
  assert.deepEqual(steered.map((item) => item.mode).sort(), ['followUp', 'steer'], '/steer joins the running answer instead of waiting');
  const sentBefore = sentTo(OWNER_TG).length;
  releaseSteer();
  await until(() => seen.includes('use metric units'), 'steer text reached the model without the command word');
  await gateway.settle();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = sentTo(OWNER_TG).slice(sentBefore);
  assert.equal(new Set(after).size, after.length, 'no answer is sent to the chat twice: ' + JSON.stringify(after));

  // 6. Commands bypass the model.
  const modelCalls = seen.length;
  statusWorkersFor = conversationId;
  telegram.message({ from: OWNER_TG, text: '/status' });
  const statusReply = await until(() => sentTo(OWNER_TG).find((t) => t.startsWith('"Plan the garden"')), '/status reply');
  assert.match(statusReply, /Helpers running: Review a\.ts\./, '/status names running helpers, not finished ones');
  telegram.message({ from: OWNER_TG, text: '/sessions' });
  await until(() => sentTo(OWNER_TG).some((t) => /^1\. /.test(t)), '/sessions reply');
  telegram.message({ from: OWNER_TG, text: '/new Shopping' });
  await until(() => sentTo(OWNER_TG).some((t) => t.startsWith('Started a new conversation')), '/new reply');
  const afterNew = (await host.harness.snapshot(GatewayDoc, context)).bindings[route];
  assert.notEqual(afterNew, conversationId, '/new rebinds the chat');
  telegram.message({ from: OWNER_TG, text: `/switch ${conversationId}` });
  await until(async () => (await host.harness.snapshot(GatewayDoc, context)).bindings[route] === conversationId, '/switch back');
  assert.equal(seen.length, modelCalls, 'commands never reach the model');

  // 7. Pairing: a stranger is denied with a code, nothing reaches Pi; approval lets them in.
  telegram.message({ from: STRANGER_TG, text: 'let me in' });
  const codeMessage = await until(() => sentTo(STRANGER_TG).find((t) => /Pairing code: [A-Z2-9]{8}/.test(t)), 'pairing code');
  assert.ok(!seen.includes('let me in'), "a stranger's text never reaches the model");
  telegram.message({ from: STRANGER_TG, text: 'again' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sentTo(STRANGER_TG).filter((t) => t.includes('Pairing code')).length, 1, 'one code per pending sender');
  const code = codeMessage.match(/Pairing code: ([A-Z2-9]{8})/)[1];
  await assert.rejects(gateway.decidePairing('ZZZZZZZZ', true), /Unknown or expired/);
  await gateway.decidePairing(code, true);
  await until(() => sentTo(STRANGER_TG).some((t) => t.startsWith('Approved')), 'approval notice');
  telegram.message({ from: STRANGER_TG, text: 'hello now' });
  await until(() => sentTo(STRANGER_TG).includes('echo: hello now'), 'approved sender answered');

  // 8. Audit: every inbound event has a record.
  const status = await gateway.status();
  const decisions = new Set(status.audit.map((a) => a.decision));
  for (const d of ['accepted', 'duplicate', 'command', 'denied', 'paired']) assert.ok(decisions.has(d), `audit has ${d}`);
  assert.ok(status.audit.every((a) => !('text' in a)), 'the audit log never stores message text');

  // 9. Platform faults: 429 waits and retries; 403 is dropped and audited.
  telegram.rateLimit(2);
  telegram.message({ from: OWNER_TG, text: 'through a rate limit' });
  await until(() => sentTo(OWNER_TG).includes('echo: through a rate limit'), 'reply after 429s');
  telegram.forbid(OWNER_TG);
  telegram.message({ from: OWNER_TG, text: 'blocked reply' });
  await until(async () => (await gateway.status()).audit.some((a) => a.decision === 'delivery_failed'), '403 recorded');
  assert.equal((await host.harness.snapshot(GatewayDoc, context)).outbox.length, 0, 'a permanently failed chunk leaves the queue');
  telegram.unforbid(OWNER_TG);

  // 10. Long replies are chunked to the platform limit.
  await api.post({ chatId: 'laptop', eventId: 'long1', text: 'LONG 40000' });
  await until(() => api.read({ chatId: 'laptop' }).items.length >= 4, 'chunked API reply');
  assert.ok(api.read({ chatId: 'laptop' }).items.every((m) => m.text.length <= 16000));

  // 11. Discord: DM, reply, reconnect with resume (no second identify), 429 and 403.
  discord.message({ author: OWNER_DC, channel: '700000000000000001', text: 'hi from discord' });
  await until(() => discord.sent.some((m) => m.content === 'echo: hi from discord'), 'discord reply');
  const identifies = discord.connections.filter((c) => c.op === 'identify').length;
  discord.drop();
  await until(() => discord.connections.some((c) => c.op === 'resume'), 'discord resume');
  discord.rateLimit(1);
  discord.message({ author: OWNER_DC, channel: '700000000000000001', text: 'after resume' });
  await until(() => discord.sent.some((m) => m.content === 'echo: after resume'), 'discord reply after resume and 429');
  assert.equal(discord.connections.filter((c) => c.op === 'identify').length, identifies, 'a reconnect resumes instead of identifying again');
  discord.forbid('700000000000000002');
  discord.message({ author: OWNER_DC, channel: '700000000000000002', guild: '800000000000000001', text: 'no permission here' });
  await until(async () => (await gateway.status()).audit.some((a) => a.decision === 'delivery_failed' && a.channel === 'discord'), 'discord 403 recorded');

  // 11b. A crashing adapter is restarted by the supervisor and never stops the others.
  let starts = 0;
  const crashing = {
    channel: 'flaky', limits: { maxText: 500 },
    async start() { starts += 1; await new Promise((resolve) => setTimeout(resolve, 10)); throw Error('socket exploded'); },
    async send() { return {}; },
    health: () => ({ state: 'failed' }),
  };
  gateway.addAdapter(crashing);
  await until(() => starts >= 3, 'supervisor restarts a crashing adapter');
  const flaky = (await gateway.status()).adapters.find((a) => a.channel === 'flaky');
  assert.ok(flaky.failures >= 2 && /socket exploded/.test(flaky.lastError), 'its failures and last error are reported, even mid-restart');
  assert.ok((await gateway.status()).audit.some((a) => a.decision === 'adapter_failed' && a.channel === 'flaky'), 'and audited');
  telegram.message({ from: OWNER_TG, text: 'still here' });
  await until(() => sentTo(OWNER_TG).includes('echo: still here'), 'Telegram keeps working while another adapter crashes');
  const fatal = { channel: 'badtoken', limits: { maxText: 500 }, async start() { throw Object.assign(Error('token rejected'), { fatal: true }); }, async send() { return {}; }, health: () => ({ state: 'stopped' }) };
  gateway.addAdapter(fatal);
  await until(async () => (await gateway.status()).adapters.find((a) => a.channel === 'badtoken')?.state === 'stopped', 'a fatal error stops without retrying');

  // 12. Restart: bindings, allowlist, an answer still being written and an unsent reply all
  // survive; a redelivery after restart submits once.
  await gateway.settle();
  telegram.rateLimit(1000); // replies cannot go out before the restart
  telegram.message({ from: OWNER_TG, text: 'queued before restart' });
  await until(async () => (await host.harness.snapshot(GatewayDoc, context)).outbox.some((j) => j.text === 'echo: queued before restart'), 'unsent reply in the outbox');
  const replayId = telegram.message({ from: OWNER_TG, text: 'SLOW 600 across a restart' });
  await until(async () => Object.keys((await host.harness.snapshot(GatewayDoc, context)).watching).length, 'slow message admitted');
  await gateway.close();
  await host.harness.close(context);
  host = await open();
  gateway = createGateway({ harness: host.harness, conversations: host.conversations, context, backoff: { firstMs: 20, maxMs: 100 } });
  const telegram2 = createTelegramAdapter({ token: TG_TOKEN, baseUrl: telegram.baseUrl, pollTimeoutSeconds: 1 });
  gateway.addAdapter(telegram2);
  await gateway.resume();
  const restored = await host.harness.snapshot(GatewayDoc, context);
  assert.equal(restored.bindings[route], conversationId, 'bindings survive a restart');
  assert.ok(restored.allow.telegram.includes(STRANGER_TG), 'approved senders survive a restart');
  telegram.rateLimit(0);
  telegram.redeliver(replayId);
  await until(() => sentTo(OWNER_TG).includes('echo: queued before restart'), 'reply queued before the restart delivered after it');
  await until(() => sentTo(OWNER_TG).includes('slow: across a restart'), 'answer finished across the restart delivered');
  await until(() => seen.filter((t) => t === 'SLOW 600 across a restart').length >= 1, 'slow run finished');
  await gateway.settle();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(seen.filter((t) => t === 'SLOW 600 across a restart').length, 1, 'a redelivery after restart submits once');
  assert.equal(sentTo(OWNER_TG).filter((t) => t === 'slow: across a restart').length, 1, 'and is answered once');
  assert.equal(sentTo(OWNER_TG).filter((t) => t === 'echo: queued before restart').length, 1, 'the queued reply is sent once');
  console.log('PASS gateway: route keys, chunking with fences, Telegram start then web then Telegram on one conversation with channel badge, duplicate delivery once, busy queue in order without touching another conversation, /steer joins the running answer, typing refreshed while answering and stopped after, commands bypass the model, pairing denies then approves, audit of every decision without text, 429 retry and 403 drop, long replies chunked, Discord resume without re-identify plus 429 and 403, a crashing adapter restarted without stopping others, /status lists running helpers, restart keeps bindings, approvals, unsent replies, in-flight answers and dedup');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  for (const open of gates.values()) void open; // a failed run may leave a gated answer pending
  setTimeout(() => process.exit(1), 3000).unref();
} finally {
  await gateway.close().catch(() => {});
  await host.harness.close(context).catch(() => {});
  await telegram.close();
  await discord.close();
}
process.exit(process.exitCode ?? 0);
