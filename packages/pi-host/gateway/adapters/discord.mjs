// Discord adapter (docs/GATEWAY.md, docs/research/telegram-discord.md). One shard over
// Node's built-in WebSocket (Hello, jittered heartbeat, Identify, Resume) plus REST with
// fetch. No library. Replies use a deterministic nonce with enforce_nonce, so a retried
// send returns the first message instead of posting twice.
// GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES. MESSAGE_CONTENT (32768) is privileged and must be
// enabled in the Developer Portal; without it Discord still sends the text of DMs and of
// messages that @mention the bot, which is all the adapter reads (docs/research/telegram-discord.md).
const BASE_INTENTS = 1 | 512 | 4096;
const MESSAGE_CONTENT = 32768;
const NO_RECONNECT = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FRESH_SESSION = new Set([4007, 4009]);

export function createDiscordAdapter({ token, apiUrl = 'https://discord.com/api/v10', gatewayUrl, fetch: fetcher = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, random = Math.random, messageContent = false }) {
  const intents = BASE_INTENTS | (messageContent ? MESSAGE_CONTENT : 0);
  if (typeof token !== 'string' || token.length < 50 || /\s/.test(token)) throw Error('Invalid Discord bot token format');
  let state = 'starting', detail = '', account = '';
  let session = null; // { id, resumeUrl, seq }
  const redact = (text) => String(text).split(token).join('[token]');

  async function rest(method, path, body) {
    const response = await fetcher(apiUrl + path, {
      method, headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const error = Error(redact(`Discord ${method} ${path.replace(/\d{17,20}/g, ':id')}: ${response.status} ${data.message ?? ''}`.trim()));
    if (response.status === 429) error.retryAfterMs = Math.ceil((data.retry_after ?? 1) * 1000);
    else if (response.status === 401) error.fatal = true;
    else if ([400, 403, 404].includes(response.status)) error.permanent = true;
    throw error;
  }

  /** A MESSAGE_CREATE or MESSAGE_UPDATE frame as an InboundEvent, or null if it is not for Mars. */
  function toEvent(payload) {
    const message = payload.d;
    const edited = payload.t === 'MESSAGE_UPDATE';
    if (message.author?.bot || !message.content) return null;
    // In a server, only messages that @mention the bot are for Mars; the mention is removed.
    const mention = new RegExp(`<@!?${account}>`, 'g');
    if (message.guild_id && !mention.test(message.content)) return null;
    const text = message.guild_id ? message.content.replace(mention, '').trim() : message.content;
    if (!text) return null;
    return {
      channel: 'discord', account, eventId: edited ? `${message.id}-edit-${message.edited_timestamp ?? payload.s}` : String(message.id),
      sender: { id: String(message.author.id), name: message.author.username ?? '' },
      chat: { id: String(message.channel_id), type: message.guild_id ? 'group' : 'dm' },
      text,
      ...(edited ? { edited: true } : {}),
    };
  }

  /** One gateway connection. Resolves when it closes; rejects for an unrecoverable close. */
  function connect(receive, signal, url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url + (url.includes('?') ? '' : '?v=10&encoding=json'));
      let heartbeat = null, acked = true, inbound = Promise.resolve();
      const stop = () => { clearInterval(heartbeat); clearTimeout(heartbeat); };
      const sendOp = (op, d) => socket.send(JSON.stringify({ op, d }));
      const beat = () => {
        if (!acked) { socket.close(4000, 'missed heartbeat ack'); return; }
        acked = false;
        sendOp(1, session?.seq ?? null);
      };
      const onAbort = () => { socket.close(1000, 'stopping'); };
      signal.addEventListener('abort', onAbort, { once: true });
      // The resume sequence only moves past a message once the gateway has recorded it, so a
      // reconnect after a failed admission replays that message instead of skipping it.
      let admitFailed = false;
      const advance = (seq) => { if (seq != null && session && !admitFailed) session.seq = Math.max(session.seq ?? 0, seq); };
      socket.addEventListener('message', (frame) => {
        const payload = JSON.parse(typeof frame.data === 'string' ? frame.data : Buffer.from(frame.data).toString());
        switch (payload.op) {
          case 10: {
            const interval = payload.d.heartbeat_interval;
            heartbeat = setTimeout(() => { beat(); heartbeat = setInterval(beat, interval); }, Math.floor(interval * random()));
            if (session?.id) sendOp(6, { token, session_id: session.id, seq: session.seq });
            else sendOp(2, { token, intents, properties: { os: process.platform, browser: 'mars', device: 'mars' } });
            break;
          }
          case 11: acked = true; break;
          case 1: sendOp(1, session?.seq ?? null); break;
          case 7: socket.close(4000, 'reconnect requested'); break;
          case 9: if (!payload.d) session = null; socket.close(4000, 'invalid session'); break;
          case 0: {
            if (payload.t === 'READY') {
              session = { id: payload.d.session_id, resumeUrl: payload.d.resume_gateway_url, seq: payload.s };
              account = String(payload.d.user.id);
              detail = payload.d.user.username ?? '';
              state = 'running';
            } else if (payload.t === 'RESUMED') state = 'running';
            break;
          }
        }
        // Every frame moves the sequence after the frames queued before it; a message frame
        // moves it only once that message is recorded (see toEvent and receive below).
        const event = payload.op === 0 && (payload.t === 'MESSAGE_CREATE' || payload.t === 'MESSAGE_UPDATE') ? toEvent(payload) : null;
        inbound = inbound.then(() => (event ? receive(event) : undefined)).then(() => advance(payload.s), (error) => {
          // Not recorded: stop advancing and reconnect, so Discord replays it on resume.
          admitFailed = true;
          detail = String(error.message).slice(0, 200);
          socket.close(4000, 'admission failed');
        });
      });
      socket.addEventListener('close', (closeEvent) => {
        stop();
        signal.removeEventListener('abort', onAbort);
        inbound.then(() => {
          if (signal.aborted) return resolve();
          const code = closeEvent.code;
          if (NO_RECONNECT.has(code)) {
            const error = Error(`Discord closed the connection (${code})${code === 4014 ? ': enable the Message Content intent in the Developer Portal' : code === 4004 ? ': the bot token is wrong' : ''}`);
            error.fatal = true;
            return reject(error);
          }
          if (FRESH_SESSION.has(code)) session = null;
          resolve();
        });
      });
      socket.addEventListener('error', () => {});
    });
  }

  return {
    channel: 'discord',
    limits: { maxText: 2000 },
    get account() { return account; },
    async start(receive, signal) {
      state = 'starting';
      const base = gatewayUrl ?? (await rest('GET', '/gateway/bot')).url;
      let quick = 0;
      while (!signal.aborted) {
        const opened = Date.now();
        await connect(receive, signal, session?.resumeUrl ?? base);
        if (signal.aborted) return;
        state = 'starting';
        quick = Date.now() - opened < 5000 ? quick + 1 : 0;
        if (quick >= 5) throw Error('Discord keeps closing the connection');
        await new Promise((resolve) => setTimeout(resolve, 250 * quick));
      }
    },
    async send({ chat, text, jobId }) {
      // The nonce is the durable delivery job, so a retry of the same job returns the first
      // message and two different replies with the same text both post.
      const nonce = 'm' + hash(chat.id + '\n' + (jobId ?? text)).slice(0, 20);
      const sent = await rest('POST', `/channels/${chat.id}/messages`, { content: text, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } });
      return { messageId: String(sent.id) };
    },
    async typing({ chat }) { await rest('POST', `/channels/${chat.id}/typing`); },
    health: () => ({ state, detail }),
  };
}

function hash(text) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0; b = Math.imul(b ^ text.charCodeAt(i), 2246822507) >>> 0; }
  return a.toString(36) + b.toString(36);
}
