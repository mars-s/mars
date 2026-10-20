import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { bootstrap, childEnvironment, configuration, REPOSITORY } from './setup.mjs';
import { checkRuntime } from './check-runtime.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(run, timeout = 45000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const value = await run(); if (value) return value; } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Isolated server did not become ready: ' + (error?.message || 'timeout'));
}
checkRuntime();
const root = await mkdtemp(join(tmpdir(), 'mars isolated install '));
const hostPort = await freePort(); let uiPort;
do { uiPort = await freePort(); } while (uiPort === hostPort);
const config = await bootstrap(configuration({ ...process.env, MARS_REPO_ROOT: REPOSITORY, MARS_UI_DIR: join(REPOSITORY, 'apps/ui'), MARS_PI_ROOT: root, MARS_PI_PORT: String(hostPort), MARS_UI_PORT: String(uiPort), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' }));
const origin = `http://127.0.0.1:${hostPort}`;
const headers = { authorization: 'Bearer ' + config.token };
let child, finished, log = '';
async function start() {
  child = spawn(process.execPath, [join(REPOSITORY, 'scripts/run.mjs'), 'production'], { cwd: REPOSITORY, env: childEnvironment(config), stdio: ['ignore', 'pipe', 'pipe'] });
  finished = once(child, 'close');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes.toString().replaceAll(config.token, '[redacted]')).slice(-6000); });
  await waitFor(async () => { const response = await fetch(origin + '/api/state', { headers, signal: AbortSignal.timeout(2000) }); return response.status === 200; });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await finished; clearTimeout(timer);
}
try {
  await start();
  assert.equal((await fetch(origin + '/api/state')).status, 401);
  const auth = await fetch(config.signInUrl, { redirect: 'manual' });
  assert.equal(auth.status, 303);
  assert.match(auth.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const state = await (await fetch(origin + '/api/state', { headers })).json();
  assert.ok(state.conversationId, 'fresh install has a native conversation');
  assert.equal(state.view.entries.length, 0, 'fresh install has no inherited conversation content');
  await waitFor(async () => {
    const response = await fetch(origin + '/', { headers, signal: AbortSignal.timeout(2000) });
    return response.status === 200 && (await response.text()).includes('Mars');
  });
  const device = await readFile(join(root, 'data/device-id'), 'utf8');
  const token = await readFile(join(root, 'data/web-token'), 'utf8');
  await stop();
  await assert.rejects(fetch(origin + '/api/state', { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(`http://127.0.0.1:${uiPort}/`, { signal: AbortSignal.timeout(1000) }));
  await start();
  const restarted = await (await fetch(origin + '/api/state', { headers })).json();
  assert.equal(restarted.conversationId, state.conversationId);
  assert.equal(restarted.view.entries.length, 0);
  assert.equal(await readFile(join(root, 'data/device-id'), 'utf8'), device);
  assert.equal(await readFile(join(root, 'data/web-token'), 'utf8'), token);
  console.log('Isolated production install passed: real UI, owner auth, empty native state, restart persistence and clean process stop. No model requests.');
} catch (error) {
  console.error(log); throw error;
} finally { await stop(); await rm(root, { recursive: true, force: true }); }
