// Telegram adapter (docs/GATEWAY.md, docs/research/telegram-discord.md). Long polling with
// fetch, no library. An update is acknowledged (offset moves past it) only after the
// gateway sink has recorded it, so a crash re-delivers it and the gateway drops the repeat.
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function createTelegramAdapter({ token, baseUrl = 'https://api.telegram.org', pollTimeoutSeconds = 25, fetch: fetcher = globalThis.fetch }) {
  if (typeof token !== 'string' || !/^\d+:[\w-]{20,}$/.test(token)) throw Error('Invalid Telegram bot token format');
  const api = (method) => `${baseUrl}/bot${token}/${method}`;
  let state = 'starting', detail = '', account = '';
  const redact = (text) => String(text).split(token).join('[token]');

  async function call(method, body, signal) {
    const response = await fetcher(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
    const data = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
    if (data.ok) return data.result;
    const error = Error(redact(`Telegram ${method}: ${data.description ?? response.status}`));
    if (response.status === 429 || data.error_code === 429) error.retryAfterMs = (data.parameters?.retry_after ?? 1) * 1000;
    else if ([400, 403, 404].includes(response.status) || [400, 403, 404].includes(data.error_code)) error.permanent = true;
    if (response.status === 401 || data.error_code === 401) error.fatal = true;
    throw error;
  }

  return {
    channel: 'telegram',
    limits: { maxText: 4096 },
    get account() { return account; },
    async start(receive, signal) {
      state = 'starting';
      const me = await call('getMe', {}, signal);
      account = String(me.id);
      state = 'running';
      detail = me.username ? '@' + me.username : '';
      let offset = 0;
      while (!signal.aborted) {
        let updates;
        try {
          updates = await call('getUpdates', { offset, timeout: pollTimeoutSeconds, allowed_updates: ['message'] }, signal);
        } catch (error) {
          if (signal.aborted) return;
          if (error.retryAfterMs) { await sleep(error.retryAfterMs, signal); continue; }
          throw error;
        }
        for (const update of updates) {
          const message = update.message;
          if (message?.text && message.from && !message.from.is_bot) {
            await receive({
              channel: 'telegram', account, eventId: String(update.update_id),
              sender: { id: String(message.from.id), name: message.from.username || message.from.first_name || '' },
              chat: { id: String(message.chat.id), type: message.chat.type === 'private' ? 'dm' : 'group' },
              ...(message.is_topic_message && message.message_thread_id ? { thread: String(message.message_thread_id) } : {}),
              text: message.text,
            });
          }
          offset = update.update_id + 1; // acknowledged on the next poll
        }
      }
    },
    async send({ chat, thread, text }) {
      const sent = await call('sendMessage', { chat_id: chat.id, text, ...(thread ? { message_thread_id: Number(thread) } : {}) });
      return { messageId: String(sent.message_id) };
    },
    async typing({ chat, thread }) {
      await call('sendChatAction', { chat_id: chat.id, action: 'typing', ...(thread ? { message_thread_id: Number(thread) } : {}) });
    },
    health: () => ({ state, detail }),
  };
}
