// Voice input limits under concurrency (voice.mjs, docs/VOICE.md): starts that arrive together,
// for example from two browser tabs, still respect the two-recording limit, and a start that fails
// while fetching the Claude token gives its place back. Fake sockets, no network.
import assert from 'node:assert/strict';
import { createVoice } from './voice.mjs';

const opened = [];
function fakeOpen(url, headers) {
  const socket = { url, headers, sent: [], closed: false, send(data) { this.sent.push(data); }, close() { this.closed = true; } };
  opened.push(socket);
  setTimeout(() => socket.onopen?.(), 2);
  return socket;
}
// The token arrives a little later, as a real credential refresh does, so every start below is
// waiting for it at the same time.
const slowToken = () => new Promise((resolve) => setTimeout(() => resolve('fixture-token'), 10));
const live = (voice) => [...voice.sessions.values()].filter((session) => !session.done).length;

const voice = createVoice({ getToken: slowToken, open: fakeOpen, maxSessions: 2 });
let tokenCalls = 0;
const flaky = createVoice({
  getToken: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    tokenCalls++;
    if (tokenCalls === 1) throw Error('credential store busy');
    return tokenCalls === 2 ? '' : 'fixture-token';
  },
  open: fakeOpen,
  maxSessions: 1,
});
try {
  // Five starts at once: two recordings, three refused with 409, and only two upstream sockets.
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => voice.start({ language: 'en' })));
  const started = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const refused = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  assert.equal(started.length, 2, 'two recordings start');
  assert.equal(refused.length, 3, 'the rest are refused');
  assert.ok(refused.every((error) => error.status === 409 && /already in use/.test(error.message)), 'refused as in use');
  assert.equal(opened.length, 2, 'only two upstream connections are opened');
  assert.equal(live(voice), 2, 'two live sessions');

  // Ending one frees its place for the next start.
  voice.cancel(started[0].id);
  const again = await voice.start({ language: 'en' });
  assert.match(again.id, /^[0-9a-f-]{36}$/);
  assert.equal(live(voice), 2);
  await assert.rejects(voice.start({ language: 'en' }), (error) => error.status === 409);

  // A token lookup that throws, or finds no Claude sign-in, gives its place back.
  await assert.rejects(flaky.start({ language: 'en' }), /credential store busy/);
  await assert.rejects(flaky.start({ language: 'en' }), (error) => error.status === 409 && /Connect Claude/.test(error.message));
  const recovered = await flaky.start({ language: 'en' });
  assert.equal(live(flaky), 1);
  assert.equal(recovered.done, false);
  console.log('voice night check passed: concurrent starts keep the two-recording limit');
} finally {
  voice.close();
  flaky.close();
}
