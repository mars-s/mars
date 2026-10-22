// HTTP API adapter (docs/GATEWAY.md "HTTP API adapter"). Owner-authenticated routes push
// messages in; replies wait in a mailbox per chat that the caller polls by sequence number.
// Mailboxes are a Pi session document, so a restart keeps unread replies and the numbering.
import { defineDoc } from '@earendil-works/pi-durable';

export const ApiMailboxDoc = defineDoc({ kind: 'mars.gateway-api-mailbox', version: 1, scope: 'session', initial: () => ({ boxes: {} }) });

/** `store` is { harness, context }; without it (unit use) mailboxes live in memory. */
export function createApiAdapter({ limit = 200, store } = {}) {
  const memory = { boxes: {} };
  let sink = null;
  const read = async () => (store ? (await store.harness.snapshot(ApiMailboxDoc, store.context)) ?? { boxes: {} } : memory);
  const write = async (change) => {
    if (!store) return change(memory);
    return store.harness.commit(async (tx) => change(await tx.doc(ApiMailboxDoc)), store.context);
  };
  return {
    channel: 'api',
    limits: { maxText: 16000 },
    async start(receive, signal) {
      sink = receive;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      sink = null;
    },
    async send({ chat, text }) {
      const seq = await write((doc) => {
        // Assign, then read back through the draft (the value of `??=` is not the draft).
        if (!doc.boxes[chat.id]) doc.boxes[chat.id] = { seq: 0, items: [] };
        const box = doc.boxes[chat.id];
        box.seq += 1;
        box.items.push({ seq: box.seq, text, at: new Date().toISOString() });
        if (box.items.length > limit) box.items.splice(0, box.items.length - limit);
        return box.seq;
      });
      return { messageId: String(seq) };
    },
    health: () => ({ state: sink ? 'running' : 'starting' }),
    /** POST /api/gateway/api/messages */
    async post({ chatId, eventId, text, sender = 'owner' }) {
      if (!sink) throw Object.assign(Error('API channel is not running'), { status: 503 });
      if (typeof chatId !== 'string' || !/^[\w.-]{1,64}$/.test(chatId)) throw Object.assign(Error('chatId must be 1 to 64 letters, digits, dots, dashes or underscores'), { status: 400 });
      if (typeof eventId !== 'string' || !eventId || eventId.length > 128 || eventId.includes(':')) throw Object.assign(Error('eventId must be a unique string of up to 128 characters, without ":"'), { status: 400 });
      if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw Object.assign(Error('text must be 1 to 100000 characters'), { status: 400 });
      return sink({ channel: 'api', account: 'owner', eventId, sender: { id: sender }, chat: { id: chatId, type: 'dm' }, text });
    },
    /** GET /api/gateway/api/messages?chatId&after */
    async read({ chatId, after = 0 }) {
      const box = (await read()).boxes[chatId] ?? { seq: 0, items: [] };
      return { items: box.items.filter((item) => item.seq > Number(after || 0)), last: box.seq };
    },
  };
}
