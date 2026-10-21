// Fake Telegram and Discord servers for the gateway checks (docs/GATEWAY.md "Acceptance").
// They emulate only what the adapters use, plus the failure modes the spec names:
// duplicate delivery, 429 rate limits, reconnect/resume and 403 permission denial.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const body = async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A fake Telegram Bot API. `push(update)` queues an update; `sent` records sendMessage calls. */
export async function fakeTelegram({ token, botId = 999 }) {
  const updates = []; // { update_id, message }
  const sent = [];
  const actions = [];
  let nextUpdate = 100, nextMessage = 1, rateLimitNext = 0, forbiddenChats = new Set(), acknowledged = 0, failPolls = 0;
  const waiting = new Set();
  const server = http.createServer(async (req, res) => {
    const [, bot, method] = req.url.split('/');
    if (bot !== 'bot' + token) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const data = await body(req);
    if (method === 'getMe') return json(res, 200, { ok: true, result: { id: botId, is_bot: true, username: 'mars_test_bot' } });
    if (method === 'getUpdates') {
      if (failPolls > 0) { failPolls--; return json(res, 502, { ok: false, error_code: 502, description: 'Bad Gateway' }); }
      acknowledged = Math.max(acknowledged, data.offset ?? 0);
      // A forced redelivery is sent once whatever the offset, as after a lost acknowledgement.
      const ready = () => updates.filter((u) => u.forced || u.update_id >= (data.offset ?? 0));
      if (!ready().length) {
        await new Promise((resolve) => { const t = setTimeout(resolve, Math.min((data.timeout ?? 0) * 1000, 300)); waiting.add(() => { clearTimeout(t); resolve(); }); });
      }
      const result = ready();
      for (const u of result) if (u.forced) updates.splice(updates.indexOf(u), 1);
      return json(res, 200, { ok: true, result: result.map(({ forced, ...u }) => u) });
    }
    if (method === 'sendMessage') {
      if (rateLimitNext > 0) { rateLimitNext--; return json(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 0.05 } }); }
      if (forbiddenChats.has(String(data.chat_id))) return json(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      if (data.text.length > 4096) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
      const message = { message_id: nextMessage++, chat: { id: data.chat_id }, text: data.text, thread: data.message_thread_id };
      sent.push(message);
      return json(res, 200, { ok: true, result: message });
    }
    if (method === 'sendChatAction') { actions.push(data); return json(res, 200, { ok: true, result: true }); }
    json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sent, actions,
    get acknowledged() { return acknowledged; },
    /** Queue a private message from `from` and return its update id. */
    message({ from, chat = from, text, updateId }) {
      const update = { update_id: updateId ?? nextUpdate++, message: { message_id: nextMessage++, from: { id: Number(from), is_bot: false, username: 'user' + from }, chat: { id: Number(chat), type: chat === from ? 'private' : 'group' }, text } };
      updates.push(update);
      for (const wake of waiting) wake();
      waiting.clear();
      return update.update_id;
    },
    /** The user edits a message they sent: an edited_message update. */
    edit({ from, chat = from, text, messageId = 1 }) {
      const update = { update_id: nextUpdate++, edited_message: { message_id: messageId, edit_date: 1, from: { id: Number(from), is_bot: false, username: 'user' + from }, chat: { id: Number(chat), type: chat === from ? 'private' : 'group' }, text } };
      updates.push(update);
      for (const wake of waiting) wake();
      waiting.clear();
      return update.update_id;
    },
    /** The next `times` getUpdates calls fail with 502, as a dropped connection would. */
    failPolls(times = 1) { failPolls = times; },
    /** Re-deliver an update that was already delivered, as Telegram does after a missed ack. */
    redeliver(updateId) {
      const original = updates.find((u) => u.update_id === updateId);
      updates.push({ ...structuredClone(original), forced: true });
      for (const wake of waiting) wake();
    },
    rateLimit(times = 1) { rateLimitNext = times; },
    forbid(chat) { forbiddenChats.add(String(chat)); },
    unforbid(chat) { forbiddenChats.delete(String(chat)); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** A fake Discord: REST (messages, typing) and a Gateway WebSocket with resume. */
export async function fakeDiscord({ token, botId = '900000000000000001' }) {
  const sent = [];
  const nonces = new Map();
  const connections = []; // { op: 'identify'|'resume', at }
  let rateLimitNext = 0, forbiddenChannels = new Set(), sessionCounter = 0, seq = 0, nextMessage = 1n;
  const backlog = []; // dispatches kept for resume
  let socket = null, privileged = true;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bot ' + token) return json(res, 401, { message: '401: Unauthorized', code: 0 });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/v10/gateway/bot') return json(res, 200, { url: `ws://127.0.0.1:${port}/gw`, shards: 1 });
    const typing = url.pathname.match(/^\/api\/v10\/channels\/(\d+)\/typing$/);
    if (typing) { res.writeHead(204); return res.end(); }
    const post = url.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages$/);
    if (req.method === 'POST' && post) {
      const data = await body(req);
      if (rateLimitNext > 0) { rateLimitNext--; return json(res, 429, { message: 'You are being rate limited.', retry_after: 0.05, global: false }); }
      if (forbiddenChannels.has(post[1])) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
      if (data.content.length > 2000) return json(res, 400, { message: 'Invalid Form Body', code: 50035 });
      if (data.enforce_nonce && nonces.has(data.nonce)) return json(res, 200, nonces.get(data.nonce));
      const message = { id: String(1300000000000000000n + nextMessage++), channel_id: post[1], content: data.content };
      sent.push(message);
      if (data.nonce) nonces.set(data.nonce, message);
      return json(res, 200, message);
    }
    json(res, 404, { message: '404: Not Found', code: 0 });
  });
  const port = await listen(server);
  const wss = new WebSocketServer({ server, path: '/gw' });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(String(raw));
      if (op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (op === 2) {
        connections.push({ op: 'identify', intents: d.intents });
        if (d.token !== token) return ws.close(4004, 'Authentication failed');
        if ((d.intents & 32768) && !privileged) return ws.close(4014, 'Disallowed intent(s)');
        sessionCounter++;
        dispatch('READY', { session_id: 'sess' + sessionCounter, resume_gateway_url: `ws://127.0.0.1:${port}/gw?resume=1`, user: { id: botId, username: 'mars-test' } });
      }
      if (op === 6) {
        connections.push({ op: 'resume', seq: d.seq });
        for (const frame of backlog.filter((f) => f.s > d.seq)) ws.send(JSON.stringify(frame));
        ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++seq, d: {} }));
      }
    });
  });
  /** The author edits a message: MESSAGE_UPDATE with edited_timestamp. */
  function edit({ author, channel, text, id, guild }) {
    return dispatch('MESSAGE_UPDATE', { id, channel_id: channel, author: { id: author, username: 'user' + author.slice(-3) }, content: text, edited_timestamp: new Date().toISOString(), ...(guild ? { guild_id: guild } : {}) });
  }
  function dispatch(t, d) {
    const frame = { op: 0, t, s: ++seq, d };
    backlog.push(frame);
    socket?.readyState === 1 && socket.send(JSON.stringify(frame));
    return frame;
  }
  return {
    apiUrl: `http://127.0.0.1:${port}/api/v10`,
    sent, connections,
    /** Dispatch MESSAGE_CREATE from `author` in `channel` (a DM when guild is omitted). */
    message({ author, channel, text, id, guild }) {
      return dispatch('MESSAGE_CREATE', { id: id ?? String(1200000000000000000n + nextMessage++), channel_id: channel, author: { id: author, username: 'user' + author.slice(-3) }, content: text, ...(guild ? { guild_id: guild } : {}) });
    },
    /** Drop the socket without a close frame the client can resume from. */
    drop() { socket?.close(4000, 'test reconnect'); },
    /** Close, then keep the next frames for resume replay. */
    dropAndQueue(messages) {
      const old = socket; socket = null; old?.terminate();
      return messages.map((m) => this.message(m));
    },
    edit,
    rateLimit(times = 1) { rateLimitNext = times; },
    forbid(channel) { forbiddenChannels.add(String(channel)); },
    disablePrivileged() { privileged = false; },
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections?.(); server.close(resolve); }),
  };
}
