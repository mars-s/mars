// Gateway core (docs/GATEWAY.md). Routes chat-platform messages to Pi conversations and
// sends the answers back. All state is native Pi documents, so a restart resumes bindings,
// pairings and unsent replies, and Pi stays the only store.
import { randomInt } from 'node:crypto';
import { InboxDoc, LiveDoc, defineDoc } from '@earendil-works/pi-durable';
import { chunkText } from './chunk.mjs';

/** Bindings, owner allowlist, pending pairings, recent event keys and the outbound queue. */
export const GatewayDoc = defineDoc({
  kind: 'mars.gateway', version: 1, scope: 'session',
  initial: () => ({ bindings: {}, allow: {}, pairings: [], seen: [], outbox: [], watching: {}, nextJob: 1, sessionsShown: {} }),
});
/** The latest audit records, newest last. Message text is never stored here. */
export const GatewayAuditDoc = defineDoc({ kind: 'mars.gateway-audit', version: 1, scope: 'session', initial: () => ({ records: [] }) });
/** The channel a conversation was started from or bound to, for the Recents badge. */
export const ChannelDoc = defineDoc({ kind: 'mars.channel', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ channel: '', route: '' }) });

export const SEEN_LIMIT = 2000;
export const AUDIT_LIMIT = 500;
export const PAIRING_TTL_MS = 60 * 60 * 1000;
export const PAIRING_MAX = 3;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const HELP = [
  'Commands:',
  '/new [title] start a new conversation in this chat',
  '/sessions list recent conversations',
  '/switch <number or id> move this chat to another conversation',
  '/status what this conversation is doing',
  '/stop stop the running answer',
  '/steer <text> send text into the running answer',
  '/help this list',
].join('\n');

/** The route key for an inbound event: one per chat (and thread). */
export function routeKey({ channel, account, chat, thread }) {
  for (const [name, value] of Object.entries({ channel, account, chatId: chat?.id }))
    if (typeof value !== 'string' || !value || value.includes(':')) throw Error(`Invalid ${name}`);
  if (chat.type !== 'dm' && chat.type !== 'group') throw Error('Invalid chat type');
  if (thread !== undefined && (typeof thread !== 'string' || !thread)) throw Error('Invalid thread');
  return `${channel}:${account}:${chat.type}:${chat.id}${thread ? `:thread:${thread}` : ''}`;
}
const eventKey = (event) => `gw:${event.channel}:${event.account}:${event.eventId}`;
const nativeId = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
const target = (route) => {
  const [channel, account, type, chatId, , thread] = route.split(':');
  return { channel, account, chat: { id: chatId, type }, ...(thread ? { thread } : {}) };
};
/** Text of an answer entry: the assistant message's text parts. */
function answerText(entry) {
  const message = entry?.model?.find?.((m) => m.role === 'assistant');
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

/**
 * The gateway for one harness. `conversations` is the host's conversation manager.
 * Adapters are added with `addAdapter` and run under a supervisor. `ready(conversationId)`
 * returns null, or a sentence for the chat when the conversation cannot answer yet (for
 * example no model provider is signed in); then nothing is submitted.
 */
export function createGateway({ harness, conversations, context, now = Date.now, log = () => {}, backoff = { firstMs: 1000, maxMs: 60000 }, ready = async () => null }) {
  const adapters = new Map(); // channel -> { adapter, state, detail, failures, controller }
  const waiters = new Map(); // submission id -> promise
  let closed = false;
  let pump = Promise.resolve();
  const wake = new Set();

  const commit = (change) => harness.commit(change, context);
  const read = async () => (await harness.snapshot(GatewayDoc, context)) ?? GatewayDoc.definition.initial();

  async function audit(record) {
    await commit(async (tx) => {
      const doc = await tx.doc(GatewayAuditDoc);
      doc.records.push({ at: new Date(now()).toISOString(), ...record });
      if (doc.records.length > AUDIT_LIMIT) doc.records.splice(0, doc.records.length - AUDIT_LIMIT);
    });
  }

  /** Queue chunks of `text` to `route`, in one commit, then start delivery. */
  async function enqueue(route, text, extra = {}) {
    const adapter = adapters.get(route.split(':')[0])?.adapter;
    const limit = adapter?.limits?.maxText ?? 2000;
    const chunks = chunkText(text, limit);
    if (!chunks.length) return;
    await commit(async (tx) => {
      const doc = await tx.doc(GatewayDoc);
      for (const chunk of chunks) doc.outbox.push({ id: doc.nextJob++, route, text: chunk, attempts: 0, notBefore: 0, ...extra });
    });
    kick();
  }

  /** Deliver queued chunks in order per route. At least once: a crash after send repeats one. */
  function kick() {
    if (closed) return;
    pump = pump.then(drain).catch((error) => log('gateway delivery: ' + error.message));
  }
  async function drain() {
    for (;;) {
      if (closed) return;
      const doc = await read();
      const blocked = new Set();
      const job = doc.outbox.find((item) => {
        if (blocked.has(item.route)) return false;
        blocked.add(item.route); // only the oldest job of each route may go
        const entry = adapters.get(item.route.split(':')[0]);
        return entry?.state === 'running' && item.notBefore <= now();
      });
      if (!job) {
        const next = doc.outbox.map((item) => item.notBefore).filter((at) => at > now()).sort((a, b) => a - b)[0];
        if (next !== undefined) setTimeout(kick, Math.min(next - now() + 5, 60000)).unref?.();
        return;
      }
      const { adapter } = adapters.get(job.route.split(':')[0]);
      let outcome;
      try {
        const sent = await adapter.send({ ...target(job.route), text: job.text });
        outcome = { done: true, messageId: sent?.messageId };
      } catch (error) {
        outcome = { error };
      }
      await commit(async (tx) => {
        const doc = await tx.doc(GatewayDoc);
        const index = doc.outbox.findIndex((item) => item.id === job.id);
        if (index < 0) return;
        if (outcome.done) { doc.outbox.splice(index, 1); return; }
        const item = doc.outbox[index];
        item.attempts += 1;
        if (outcome.error.permanent || item.attempts >= 8) doc.outbox.splice(index, 1);
        else item.notBefore = now() + (outcome.error.retryAfterMs ?? Math.min(1000 * 2 ** item.attempts, 60000));
      });
      if (outcome.error) {
        const dropped = outcome.error.permanent || job.attempts + 1 >= 8;
        await audit({ channel: job.route.split(':')[0], route: job.route, decision: dropped ? 'delivery_failed' : 'delivery_retry', detail: String(outcome.error.message).slice(0, 200) });
      }
    }
  }

  /** Wait for a submission to settle, then send its answer to every route bound to the conversation. */
  function follow(conversationId, submissionId) {
    if (waiters.has(submissionId)) return waiters.get(submissionId);
    const promise = (async () => {
      const submission = await harness.submission(submissionId, context);
      if (!submission) return;
      const settled = await submission.wait(context);
      const doc = await read();
      const routes = Object.entries(doc.bindings).filter(([, id]) => String(id) === String(conversationId)).map(([route]) => route);
      if (settled.status === 'done') {
        const conversation = await harness.conversation(nativeId(conversationId), context);
        const entry = await conversation.commit((tx) => tx.entry(settled.answer), context);
        const text = answerText(entry) || '(The answer had no text.)';
        for (const route of routes) await enqueue(route, text, { submissionId });
      } else {
        const why = { model_error: 'the model returned an error', aborted: 'it was stopped', stale: 'it was replaced' }[settled.reason] ?? settled.reason ?? 'unknown';
        const detail = settled.detail ? ` (${String(settled.detail).slice(0, 200)})` : '';
        for (const route of routes) await enqueue(route, `No answer: ${why}${detail}.`, { submissionId });
      }
      await commit(async (tx) => { delete (await tx.doc(GatewayDoc)).watching[submissionId]; });
    })().catch((error) => log('gateway follow: ' + error.message)).finally(() => waiters.delete(submissionId));
    waiters.set(submissionId, promise);
    return promise;
  }

  async function bind(route, conversationId, channel) {
    await commit(async (tx) => {
      (await tx.doc(GatewayDoc)).bindings[route] = String(conversationId);
      Object.assign(await tx.doc(ChannelDoc, nativeId(conversationId)), { channel, route });
    });
  }

  async function bindNew(event, route, title) {
    const conversation = await conversations.create({ title: (title || event.text || 'Chat').replace(/\s+/g, ' ').trim().slice(0, 60) });
    await bind(route, conversation.id, event.channel);
    return conversation;
  }

  async function command(event, route, conversationId) {
    const [name, ...words] = event.text.trim().split(/\s+/);
    const rest = event.text.trim().slice(name.length).trim();
    switch (name.toLowerCase()) {
      case '/help': case '/start': return HELP;
      case '/new': {
        const conversation = await bindNew(event, route, rest || 'New chat');
        return `Started a new conversation (${conversation.id}). Send a message to begin.`;
      }
      case '/sessions': {
        const rows = (await conversations.list()).slice(0, 10);
        await commit(async (tx) => { (await tx.doc(GatewayDoc)).sessionsShown[route] = rows.map((row) => row.id); });
        return rows.map((row, i) => `${i + 1}. ${row.title}${row.running ? ' (running)' : ''}${row.id === conversationId ? ' (this chat)' : ''} [${row.id}]`).join('\n') || 'No conversations yet.';
      }
      case '/switch': {
        const wanted = words[0];
        if (!wanted) return 'Usage: /switch <number from /sessions, or a conversation id>';
        const shown = (await read()).sessionsShown[route] ?? [];
        const id = /^\d{1,2}$/.test(wanted) && shown[Number(wanted) - 1] ? shown[Number(wanted) - 1] : wanted;
        try { await conversations.resolve(id); } catch { return `No conversation ${wanted}. Use /sessions to see the list.`; }
        await bind(route, id, event.channel);
        const title = (await conversations.list()).find((row) => row.id === String(id))?.title ?? `conversation ${id}`;
        return `This chat now continues "${title}" [${id}].`;
      }
      case '/status': {
        if (!conversationId) return 'This chat has no conversation yet. Send a message to start one.';
        const [live, inbox, row] = await Promise.all([
          harness.snapshot(LiveDoc, nativeId(conversationId), context),
          harness.snapshot(InboxDoc, nativeId(conversationId), context),
          conversations.list().then((rows) => rows.find((r) => r.id === String(conversationId))),
        ]);
        const queued = inbox?.items?.length ?? 0;
        return `"${row?.title ?? conversationId}" [${conversationId}]: ${live?.run ? 'answering' : 'idle'}${queued ? `, ${queued} queued` : ''}.`;
      }
      case '/stop': {
        if (!conversationId) return 'Nothing to stop.';
        await (await conversations.resolve(conversationId)).abort(context);
        return 'Stopped.';
      }
      default: return `Unknown command ${name}. ${HELP}`;
    }
  }

  /**
   * Handle one inbound platform message. Resolves once it is safely recorded, so the adapter
   * acknowledges its platform only after this. One at a time, so a redelivery racing the
   * original sees it as already seen.
   */
  let inbound = Promise.resolve();
  function receive(event) {
    const result = inbound.then(() => admit(event));
    inbound = result.catch(() => {});
    return result;
  }
  async function admit(event) {
    const route = routeKey(event);
    const key = eventKey(event);
    const doc = await read();
    const base = { channel: event.channel, sender: event.sender.id, route, eventId: event.eventId };
    if (doc.seen.includes(key)) { await audit({ ...base, decision: 'duplicate' }); return { status: 'duplicate' }; }
    const allowed = (doc.allow[event.channel] ?? []).includes(event.sender.id);
    if (!allowed) return pairing(event, route, base, key);
    const remember = async (extra = {}) => commit(async (tx) => {
      const draft = await tx.doc(GatewayDoc);
      draft.seen.push(key);
      if (draft.seen.length > SEEN_LIMIT) draft.seen.splice(0, draft.seen.length - SEEN_LIMIT);
      Object.assign(draft.watching, extra);
    });
    let conversationId = doc.bindings[route];
    const text = event.text.trim();
    if (text.startsWith('/') && !/^\/steer\b/i.test(text)) {
      await remember();
      const reply = await command(event, route, conversationId);
      await audit({ ...base, decision: 'command', command: text.split(/\s+/)[0].toLowerCase(), conversationId: (await read()).bindings[route] ?? null });
      await enqueue(route, reply);
      return { status: 'command' };
    }
    const steer = /^\/steer\b/i.test(text);
    const content = steer ? text.replace(/^\/steer\s*/i, '') : text;
    if (!content) { await enqueue(route, 'Nothing to send.'); return { status: 'empty' }; }
    if (!conversationId) conversationId = String((await bindNew(event, route, content)).id);
    const notReady = await ready(conversationId);
    if (notReady) {
      await remember();
      await audit({ ...base, decision: 'not_ready', conversationId: String(conversationId) });
      await enqueue(route, notReady);
      return { status: 'not_ready', conversationId: String(conversationId) };
    }
    const conversation = await conversations.resolve(conversationId);
    // requestId makes a redelivered event return the first submission, even after a restart.
    const submission = await conversation.submit({
      type: 'input', content, requestId: key, whenBusy: steer ? 'steer' : 'followUp',
      entry: { kind: 'mars.user', data: { attachments: [], channel: event.channel, sender: event.sender.name ?? event.sender.id } },
    }, context);
    await remember({ [submission.id]: String(conversationId) });
    await audit({ ...base, decision: 'accepted', conversationId: String(conversationId), submissionId: submission.id });
    const typing = adapters.get(event.channel)?.adapter.typing;
    if (typing) Promise.resolve().then(() => typing(target(route))).catch(() => {});
    follow(conversationId, submission.id);
    return { status: 'accepted', conversationId: String(conversationId), submissionId: submission.id };
  }

  async function pairing(event, route, base, key) {
    let code, fresh = false;
    const outcome = await commit(async (tx) => {
      const doc = await tx.doc(GatewayDoc);
      doc.pairings = doc.pairings.filter((p) => p.expiresAt > now());
      const existing = doc.pairings.find((p) => p.channel === event.channel && p.sender === event.sender.id);
      if (existing) { code = existing.code; return 'pending'; }
      if (doc.pairings.filter((p) => p.channel === event.channel).length >= PAIRING_MAX) return 'full';
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      doc.pairings.push({ code, channel: event.channel, sender: event.sender.id, name: event.sender.name ?? '', route, createdAt: now(), expiresAt: now() + PAIRING_TTL_MS });
      fresh = true;
      doc.seen.push(key);
      return 'created';
    });
    await audit({ ...base, decision: 'denied', pairing: outcome });
    if (fresh) await enqueue(route, `This Mars is private. Pairing code: ${code}\nAsk the owner to approve it in Mars (Settings, Gateway). It expires in 1 hour.`);
    return { status: 'denied', pairing: outcome };
  }

  /** Approve or reject a pairing code. Approval allows that sender on that channel. */
  async function decidePairing(code, approve) {
    const found = await commit(async (tx) => {
      const doc = await tx.doc(GatewayDoc);
      const index = doc.pairings.findIndex((p) => p.code === String(code).toUpperCase() && p.expiresAt > now());
      if (index < 0) return null;
      const [pairing] = doc.pairings.splice(index, 1);
      if (approve) (doc.allow[pairing.channel] ??= []).includes(pairing.sender) || doc.allow[pairing.channel].push(pairing.sender);
      return { ...pairing };
    });
    if (!found) throw Object.assign(Error('Unknown or expired pairing code'), { status: 404 });
    await audit({ channel: found.channel, sender: found.sender, route: found.route, decision: approve ? 'paired' : 'pairing_rejected' });
    if (approve) await enqueue(found.route, 'Approved. You can now talk to Mars here. Send /help for commands.');
    return { channel: found.channel, sender: found.sender, approved: !!approve };
  }

  /** Allow a sender directly (the owner's own account from configuration). Idempotent. */
  async function allow(channel, sender) {
    await commit(async (tx) => {
      const doc = await tx.doc(GatewayDoc);
      (doc.allow[channel] ??= []).includes(sender) || doc.allow[channel].push(sender);
    });
  }

  async function unbind(route) {
    await commit(async (tx) => { delete (await tx.doc(GatewayDoc)).bindings[route]; });
  }

  /**
   * Run an adapter under a supervisor: a crash marks it failed and restarts it with backoff.
   * The sink is `receive`; an adapter acknowledges its platform only after the sink resolves.
   */
  function addAdapter(adapter) {
    if (adapters.has(adapter.channel)) throw Error(`Adapter ${adapter.channel} already added`);
    const entry = { adapter, state: 'starting', detail: '', failures: 0, controller: null };
    adapters.set(adapter.channel, entry);
    (async () => {
      while (!closed) {
        entry.controller = new AbortController();
        entry.state = 'running';
        entry.detail = '';
        kick();
        try {
          await adapter.start(receive, entry.controller.signal);
          if (closed || entry.controller.signal.aborted) break;
          throw Error('Adapter stopped unexpectedly');
        } catch (error) {
          if (closed || entry.controller.signal.aborted) break;
          if (error.fatal) { entry.state = 'stopped'; entry.detail = String(error.message); return; }
          entry.failures += 1;
          entry.state = 'failed';
          entry.detail = String(error.message).slice(0, 300);
          log(`gateway adapter ${adapter.channel} failed: ${entry.detail}`);
          await audit({ channel: adapter.channel, decision: 'adapter_failed', detail: entry.detail }).catch(() => {});
          const wait = Math.min(backoff.firstMs * 2 ** (entry.failures - 1), backoff.maxMs);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
      entry.state = 'stopped';
    })();
  }

  async function status() {
    const doc = await read();
    const audit = (await harness.snapshot(GatewayAuditDoc, context))?.records ?? [];
    const titles = new Map((await conversations.list()).map((row) => [row.id, row.title]));
    return {
      adapters: [...adapters.values()].map(({ adapter, state, detail, failures }) => ({
        channel: adapter.channel, state: adapter.health?.()?.state === 'stopped' ? 'stopped' : state,
        detail: detail || adapter.health?.()?.detail || '', failures,
      })),
      bindings: Object.entries(doc.bindings).map(([route, conversationId]) => ({ route, channel: route.split(':')[0], conversationId, title: titles.get(conversationId) ?? `Conversation ${conversationId}` })),
      pairings: doc.pairings.filter((p) => p.expiresAt > now()).map(({ code, channel, sender, name, expiresAt }) => ({ code, channel, sender, name, expiresAt: new Date(expiresAt).toISOString() })),
      allowed: doc.allow,
      outbox: doc.outbox.length,
      audit: audit.slice(-50).reverse(),
    };
  }

  /** After a restart: follow submissions still waiting for an answer, and resume delivery. */
  async function resume() {
    const doc = await read();
    for (const [submissionId, conversationId] of Object.entries(doc.watching)) follow(conversationId, Number(submissionId));
    kick();
  }

  /** Bind a web UI reply to the chats of a conversation: answers to web messages reach them too. */
  function watchSubmission(conversationId, submissionId) {
    return (async () => {
      const doc = await read();
      if (!Object.values(doc.bindings).includes(String(conversationId))) return;
      await commit(async (tx) => { (await tx.doc(GatewayDoc)).watching[submissionId] = String(conversationId); });
      follow(conversationId, submissionId);
    })();
  }

  async function close() {
    closed = true;
    for (const entry of adapters.values()) entry.controller?.abort();
    await Promise.allSettled([...waiters.values()]);
    await pump.catch(() => {});
  }

  return { receive, addAdapter, decidePairing, allow, unbind, status, resume, watchSubmission, close, idle: () => pump, settle: () => Promise.allSettled([...waiters.values()]).then(() => pump) };
}
