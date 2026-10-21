// Discord adapter on its own against the fake Discord (docs/GATEWAY.md): a message whose
// admission fails is replayed after a reconnect instead of skipped, and the resume sequence
// never moves past a message that was not recorded.
import assert from 'node:assert/strict';
import { createDiscordAdapter } from './gateway/adapters/discord.mjs';
import { fakeDiscord } from './gateway/fakes.mjs';

setTimeout(() => { console.error('check-gateway-discord: timed out'); process.exit(1); }, 30000).unref();
const token = 'D'.repeat(24) + '.' + 'x'.repeat(6) + '.' + 'y'.repeat(38);
const discord = await fakeDiscord({ token });
const adapter = createDiscordAdapter({ token, apiUrl: discord.apiUrl });
const recorded = [];
let failNext = 0;
const receive = async (event) => {
  if (failNext > 0) { failNext--; throw Error('store unavailable'); }
  recorded.push(event.text);
};
const controller = new AbortController();
const running = adapter.start(receive, controller.signal).catch((error) => error);
const until = async (predicate, what, ms = 8000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  await until(() => adapter.health().state === 'running', 'ready');
  discord.message({ author: '400000000000000001', channel: '700000000000000001', text: 'first' });
  await until(() => recorded.includes('first'), 'first recorded');

  failNext = 1;
  discord.message({ author: '400000000000000001', channel: '700000000000000001', text: 'second' });
  await until(() => discord.connections.some((c) => c.op === 'resume'), 'reconnect after a failed admission');
  await until(() => recorded.includes('second'), 'the failed message is replayed on resume and recorded');
  const resume = discord.connections.find((c) => c.op === 'resume');
  assert.ok(resume.seq < 3, `resume starts before the unrecorded message (seq ${resume.seq})`);
  discord.message({ author: '400000000000000001', channel: '700000000000000001', text: 'third' });
  await until(() => recorded.includes('third'), 'later messages still arrive');
  assert.deepEqual(recorded, ['first', 'second', 'third'], 'nothing lost, nothing out of order');
  console.log('PASS gateway Discord: a message whose admission fails is replayed after a reconnect, the resume sequence never passes an unrecorded message, nothing is lost or reordered');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  controller.abort();
  await running;
  await discord.close();
}
process.exit(process.exitCode ?? 0);
