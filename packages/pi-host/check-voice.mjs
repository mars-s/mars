// Voice input (voice.mjs) with a fake Claude speech-to-text socket and a real HTTP server using
// the same route code as the host: start, audio forwarding, live and final transcripts by long
// polling, stop, errors, limits and cleanup. No network, no microphone.
import assert from 'node:assert/strict';
import http from 'node:http';
import { CHUNK_MAX, VOICE_URL, createVoice, voiceRoute } from './voice.mjs';

const sockets = [];
function fakeOpen(url, headers) {
  const socket = { url, headers, sent: [], closed: false, send(data) { this.sent.push(data); }, close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose?.(), 1); } };
  sockets.push(socket);
  setTimeout(() => (socket.refuse ? socket.onerror?.() : socket.onopen?.()), 2);
  return socket;
}
const say = (socket, message) => socket.onmessage?.({ data: JSON.stringify(message) });
let token = 'fixture-token';
const voice = createVoice({ getToken: async () => token, open: fakeOpen, maxSessions: 2, keepAliveMs: 20, finishMs: 200, idleMs: 300, sweepMs: 50 });
const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const jsonBody = async (req) => { let s = ''; for await (const c of req) s += c; return JSON.parse(s || '{}'); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (!(await voiceRoute({ voice, req, res, url, send, jsonBody }))) send(res, 404, { error: 'no route' });
  } catch (error) { send(res, error.status || 500, { error: error.message }); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

try {
  // Start: the upstream URL, headers and the first keep-alive.
  const started = await call('/api/voice', { language: 'en-AU' });
  assert.equal(started.status, 201);
  const id = started.json.id;
  const socket = sockets[0];
  assert.ok(socket.url.startsWith(VOICE_URL + '?'));
  const query = new URL(socket.url).searchParams;
  assert.deepEqual([query.get('encoding'), query.get('sample_rate'), query.get('channels'), query.get('language')], ['linear16', '16000', '1', 'en']);
  assert.equal(socket.headers.Authorization, 'Bearer fixture-token');
  assert.equal(socket.sent[0], '{"type":"KeepAlive"}');
  assert.ok(!JSON.stringify(started.json).includes('fixture-token'), 'the token never reaches the browser');

  // Audio is forwarded as binary; bad chunks are refused.
  const pcm = Buffer.alloc(3200, 1);
  assert.equal((await call(`/api/voice/${id}/audio`, { audio: pcm.toString('base64') })).status, 200);
  // A keep-alive (every 20 ms here) can land after the audio on a busy machine, so look for the chunk itself.
  assert.ok(socket.sent.some((data) => Buffer.isBuffer(data) && data.equals(pcm)));
  assert.equal((await call(`/api/voice/${id}/audio`, { audio: Buffer.alloc(3).toString('base64') })).status, 400, 'odd byte count');
  assert.equal((await call(`/api/voice/${id}/audio`, { audio: 'not base64!' })).status, 400);
  assert.equal((await call(`/api/voice/${id}/audio`, { audio: Buffer.alloc(CHUNK_MAX + 2).toString('base64') })).status, 413, 'too big');

  // Long polling: wakes on new text, carries interim then final segments.
  const waiting = call(`/api/voice/${id}?since=${started.json.seq}&wait=5000`);
  setTimeout(() => say(socket, { type: 'TranscriptText', data: 'Hello' }), 30);
  const first = await waiting;
  assert.deepEqual([first.json.text, first.json.done], ['Hello', false]);
  say(socket, { type: 'TranscriptText', data: 'Hello there' });
  say(socket, { type: 'TranscriptEndpoint' });
  say(socket, { type: 'TranscriptText', data: 'second' });
  const second = await call(`/api/voice/${id}?since=${first.json.seq}&wait=1000`);
  assert.equal(second.json.text, 'Hello there second');
  const idle = Date.now();
  const nothing = await call(`/api/voice/${id}?since=${second.json.seq + 100}&wait=150`);
  assert.ok(Date.now() - idle >= 140, 'a poll with nothing new waits');
  assert.equal(nothing.json.text, 'Hello there second');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(socket.sent.filter((m) => m === '{"type":"KeepAlive"}').length >= 2, 'keep-alives continue');

  // Stop: CloseStream, then the final words, then done.
  const stopping = call(`/api/voice/${id}/stop`, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(socket.sent.at(-1), '{"type":"CloseStream"}');
  say(socket, { type: 'TranscriptText', data: 'second sentence.' });
  say(socket, { type: 'TranscriptEndpoint' });
  const stopped = await stopping;
  assert.deepEqual([stopped.json.text, stopped.json.done, stopped.json.error], ['Hello there second sentence.', true, undefined]);
  assert.equal((await call(`/api/voice/${id}/audio`, { audio: pcm.toString('base64') })).json.done, true, 'audio after stop is ignored');

  // Stop without a final endpoint still finishes (safety timer).
  const quiet = (await call('/api/voice', {})).json.id;
  const t = Date.now();
  const quietStop = await call(`/api/voice/${quiet}/stop`, {});
  assert.equal(quietStop.json.done, true);
  assert.ok(Date.now() - t < 1500);

  // Errors from upstream, refused connections, no Claude sign-in, limits.
  const bad = (await call('/api/voice', {})).json.id;
  say(sockets.at(-1), { type: 'TranscriptError', description: 'audio format not supported' });
  assert.equal((await call(`/api/voice/${bad}?since=-1&wait=10`)).json.error, 'audio format not supported');
  const refusing = fakeOpen; let refuseNext = true;
  const voiceRefuse = createVoice({ getToken: async () => 't', open: (u, h) => { const s = refusing(u, h); s.refuse = refuseNext; return s; } });
  await assert.rejects(voiceRefuse.start({}), /refused the connection/);
  voiceRefuse.close();
  token = '';
  assert.equal((await call('/api/voice', {})).status, 409);
  assert.match((await call('/api/voice', {})).json.error, /Connect Claude/);
  token = 'fixture-token';
  assert.equal((await call('/api/voice', { language: 'english please' })).status, 400);
  const a = (await call('/api/voice', {})).json.id;
  const b = (await call('/api/voice', {})).json.id;
  assert.equal((await call('/api/voice', {})).status, 409, 'at most two recordings at once');
  assert.deepEqual((await call(`/api/voice/${a}/cancel`, {})).json, { cancelled: true });
  // An idle recording is stopped by the sweeper.
  await new Promise((r) => setTimeout(r, 450));
  assert.match((await call(`/api/voice/${b}?since=-1&wait=10`)).json.error, /idle/);
  assert.equal((await call('/api/voice/00000000-0000-0000-0000-000000000000?since=0&wait=10')).status, 404);
  console.log('PASS voice: upstream URL and headers, token stays on the host, binary audio forwarded, chunk checks, long poll wakes and waits, interim and final segments, keep-alives, stop sends CloseStream and returns the last words, safety finish, upstream errors, refused connection, no Claude sign-in, language check, two-session limit, cancel, idle sweep, unknown session');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  voice.close();
  server.close();
}
process.exit(process.exitCode ?? 0);
