// Voice input (docs/VOICE.md): the composer's microphone streams 16 kHz mono 16-bit PCM to the
// host in small JSON POSTs (base64, as every Mars proxy accepts JSON), and the host relays it to Claude's speech-to-text stream with the owner's
// Claude sign-in. The token never reaches the browser. Transcripts come back by long polling, so it
// works through every proxy Mars sits behind (no browser WebSocket needed).
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const VOICE_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const KEEP_ALIVE = '{"type":"KeepAlive"}';
const CLOSE_STREAM = '{"type":"CloseStream"}';
export const CHUNK_MAX = 64 * 1024;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** The upstream socket: the platform WebSocket, which accepts headers in Node. */
const openSocket = (url, headers) => new WebSocket(url, { headers });

export function createVoice({ getToken, open = openSocket, maxSessions = 2, idleMs = 60000, maxMs = 5 * 60000, keepAliveMs = 8000, finishMs = 5000, sweepMs = 5000, now = Date.now } = {}) {
  const sessions = new Map();

  function publish(session) {
    session.seq++;
    for (const wake of session.waiters.splice(0)) wake();
  }
  function end(session, error) {
    if (session.done) return;
    session.done = true;
    if (error && !session.error) session.error = error;
    clearInterval(session.keepAlive);
    clearTimeout(session.finishTimer);
    try { session.socket.close(); } catch {}
    publish(session);
    // Keep the final state briefly so the last poll can read it.
    setTimeout(() => sessions.delete(session.id), 30000).unref?.();
  }
  const text = (session) => [...session.finals, session.interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  function view(session) {
    return { id: session.id, seq: session.seq, text: text(session), interim: session.interim, done: session.done, ...(session.error ? { error: session.error } : {}) };
  }
  function find(id) {
    const session = sessions.get(String(id));
    if (!session) throw fail('That voice session has ended. Start recording again.', 404);
    return session;
  }
  // Sweep idle and over-long sessions.
  const sweeper = setInterval(() => {
    for (const session of sessions.values())
      if (!session.done && (now() - session.lastActivity > idleMs || now() - session.startedAt > maxMs)) end(session, 'Recording stopped: it was idle or longer than five minutes.');
  }, sweepMs);
  sweeper.unref?.();

  return {
    /** Open a stream to Claude's speech-to-text. Resolves once it is connected. */
    async start({ language = 'en' } = {}) {
      if (!LANGUAGE.test(String(language))) throw fail('language must be a code such as "en" or "en-AU"');
      const live = [...sessions.values()].filter((session) => !session.done);
      if (live.length >= maxSessions) throw fail('Voice input is already in use. Stop the other recording first.', 409);
      const token = await getToken();
      if (!token) throw fail('Voice input uses your Claude account. Connect Claude in Settings, Account, first.', 409);
      const query = new URLSearchParams({ encoding: 'linear16', sample_rate: '16000', channels: '1', endpointing_ms: '300', utterance_end_ms: '1000', language: String(language).split('-')[0], use_conversation_engine: 'true' });
      const socket = open(`${VOICE_URL}?${query}`, { Authorization: `Bearer ${token}`, 'User-Agent': 'claude-cli/2.1.309 (external, cli)', 'x-app': 'cli', 'anthropic-client-platform': 'cli' });
      const session = { id: randomUUID(), socket, seq: 0, finals: [], interim: '', done: false, error: '', waiters: [], startedAt: now(), lastActivity: now(), closing: false };
      sessions.set(session.id, session);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { end(session, 'Could not reach Claude speech-to-text.'); reject(fail('Could not reach Claude speech-to-text. Try again.', 502)); }, 8000);
        socket.onopen = () => { clearTimeout(timer); socket.send(KEEP_ALIVE); resolve(); };
        socket.onerror = () => { clearTimeout(timer); end(session, 'The speech-to-text connection failed.'); reject(fail('Claude speech-to-text refused the connection. Reconnect Claude in Settings, Account, and try again.', 502)); };
      });
      session.keepAlive = setInterval(() => { try { socket.send(KEEP_ALIVE); } catch {} }, keepAliveMs);
      session.keepAlive.unref?.();
      socket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'TranscriptText' || message.type === 'TranscriptInterim') {
          session.interim = String(message.data ?? '');
          publish(session);
        } else if (message.type === 'TranscriptEndpoint') {
          if (session.interim) session.finals.push(session.interim);
          session.interim = '';
          publish(session);
          if (session.closing) end(session);
        } else if (message.type === 'TranscriptError' || message.type === 'error') {
          end(session, String(message.description ?? message.message ?? message.error_code ?? 'Transcription failed.'));
        }
      };
      socket.onerror = () => end(session, 'The speech-to-text connection failed.');
      socket.onclose = () => { if (session.interim) { session.finals.push(session.interim); session.interim = ''; } end(session); };
      return view(session);
    },
    /** Forward one chunk of 16 kHz mono 16-bit PCM. */
    audio(id, chunk) {
      const session = find(id);
      if (session.done || session.closing) return view(session);
      if (!chunk?.length) return view(session);
      if (chunk.length > CHUNK_MAX) throw fail(`Audio chunks must be at most ${CHUNK_MAX} bytes.`, 413);
      if (chunk.length % 2) throw fail('Audio must be 16-bit samples.');
      session.lastActivity = now();
      session.socket.send(chunk);
      return view(session);
    },
    /** The transcript, waiting up to waitMs for something newer than `since`. */
    async poll(id, since = -1, waitMs = 10000) {
      const session = find(id);
      if (session.seq <= since && !session.done) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          session.waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      return view(session);
    },
    /** Finish: send what was said, wait for the last words, then close. */
    async stop(id) {
      const session = find(id);
      if (!session.done && !session.closing) {
        session.closing = true;
        // Nothing may follow CloseStream, not even a keep-alive.
        clearInterval(session.keepAlive);
        try { session.socket.send(CLOSE_STREAM); } catch { end(session); }
        session.finishTimer = setTimeout(() => end(session), finishMs);
      }
      while (!session.done) await new Promise((resolve) => session.waiters.push(resolve));
      return view(session);
    },
    cancel(id) {
      const session = sessions.get(String(id));
      if (session) end(session, 'Cancelled.');
      return { cancelled: !!session };
    },
    sessions,
    close() { clearInterval(sweeper); for (const session of sessions.values()) end(session, 'Mars is stopping.'); },
  };
}

/** HTTP routes for the composer (owner auth is checked by the server before this runs). */
export async function voiceRoute({ voice, req, res, url, send, jsonBody }) {
  const match = /^\/api\/voice(?:\/([0-9a-f-]{36}))?(?:\/(audio|stop|cancel))?$/.exec(url.pathname);
  if (!match) return false;
  const [, id, action] = match;
  if (!id && req.method === 'POST') { send(res, 201, await voice.start(await jsonBody(req))); return true; }
  if (id && !action && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? -1);
    send(res, 200, await voice.poll(id, Number.isFinite(since) ? since : -1, Math.min(15000, Number(url.searchParams.get('wait') ?? 10000) || 0)));
    return true;
  }
  if (id && action === 'audio' && req.method === 'POST') {
    const { audio } = await jsonBody(req);
    if (typeof audio !== 'string' || audio.length > Math.ceil(CHUNK_MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw fail('audio must be base64 PCM, at most 64 KB per chunk', 400);
    send(res, 200, voice.audio(id, Buffer.from(audio, 'base64')));
    return true;
  }
  if (id && action === 'stop' && req.method === 'POST') { send(res, 200, await voice.stop(id)); return true; }
  if (id && action === 'cancel' && req.method === 'POST') { send(res, 200, voice.cancel(id)); return true; }
  return false;
}
