import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './dev-tools.mjs';
import { publicOrigin, requestPolicy } from './security.mjs';

assert.throws(() => publicOrigin('https://example.test/path'), /origin/);
assert.throws(() => publicOrigin('https://user:pass@example.test'), /origin/);
assert.throws(() => publicOrigin('ftp://example.test'), /origin/);
const configured = requestPolicy({ port: 4001, origin: 'https://private.example.test:9443', aliases: [] });
assert.equal(configured.hostAllowed('private.example.test:9443'), true);
assert.equal(configured.hostAllowed('evil.test'), false);
assert.equal(configured.originAllowed('private.example.test:9443', 'http://private.example.test:9443'), false);
assert.equal(configured.originAllowed('localhost:4001', 'https://private.example.test:9443'), false);

const base = await mkdtemp(join(tmpdir(), 'mars portable root '));
const root = join(base, 'data home/mars');
const port = await freePort(), uiPort = await freePort();
const publicHost = 'private.example.test:9443';
const publicOriginValue = 'https://' + publicHost;
const ui = http.createServer((_req, res) => res.end('PORTABLE_UI_PROXY'));
ui.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); });
await new Promise(resolve => ui.listen(uiPort, '127.0.0.1', resolve));
const env = { ...process.env, MARS_PI_ROOT: '', XDG_DATA_HOME: join(base, 'data home'), MARS_CONFIG_DIR: join(base, 'config'), MARS_PI_PORT: String(port), MARS_UI_PORT: String(uiPort), MARS_PUBLIC_ORIGIN: publicOriginValue, MARS_ALLOWED_ORIGINS: 'https://alias.example.test:9443', MARS_PI_STAGING: '1' };
let child, exited;
async function start(overrides = {}) {
  let log = '';
  child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { cwd: base, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  exited = new Promise(resolve => child.once('close', resolve));
  const ready = await Promise.race([
    (async () => { for (let n = 0; n < 300; n++) { if (log.includes('agent ready')) return true; await new Promise(resolve => setTimeout(resolve, 100)); } return false; })(),
    exited.then(() => false),
  ]);
  assert.ok(ready, 'Fresh host boots with arbitrary working/data roots: ' + log.slice(-3000));
}
async function stop() {
  child?.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}
const request = (path, init = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, method: init.method || 'GET', headers: init.headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject); req.end(init.body);
});
function upgrade(headers, host = publicHost) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(Error('Upgrade timed out')));
    socket.on('connect', () => socket.write('GET /_next/webpack-hmr HTTP/1.1\r\nHost: ' + host + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' + Object.entries(headers).map(([key, value]) => key + ': ' + value + '\r\n').join('') + '\r\n'));
    socket.on('data', chunk => { data += chunk; if (data.includes('\r\n')) { socket.destroy(); resolve(data.split('\r\n')[0]); } });
    socket.on('error', reject);
  });
}
try {
  await start();
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/state', { headers: { host: 'evil.test' } })).status, 403);
  const token = (await readFile(join(root, 'data/web-token'), 'utf8')).trim();
  const auth = { authorization: 'Bearer ' + token };
  const state = await (await request('/api/state', { headers: auth })).json();
  assert.ok(state.conversationId);
  assert.equal(state.auth.connected, false);
  assert.ok(["estimated", "reported"].includes(state.context.basis), "live host reports context: " + JSON.stringify(state.context));
  assert.ok(state.context.limit > 0 && state.context.used >= 0 && state.context.compactAt > 0 && state.context.compactAt < 1);
  assert.equal(state.context.segments.reduce((sum, segment) => sum + segment.tokens, 0), state.context.used);
  const luna = state.models.find((model) => model.id === "gpt-6-luna");
  assert.ok(luna && luna.provider === "openai" && luna.efforts.includes("medium"), "models carry Pi's supported effort levels");
  assert.ok(state.models.some((model) => model.provider === "anthropic"), "Claude models are labelled by provider");
  assert.equal(typeof state.thinkingLevel, "string");
  const post = (path, body) => request(path, { method: "POST", headers: { ...auth, origin: "http://127.0.0.1:" + port, "content-type": "application/json" }, body: JSON.stringify(body) });
  const effort = await post("/api/effort", { effort: "high" });
  assert.equal(effort.status, 200, "effort accepted: " + await effort.clone().text());
  assert.equal((await (await request("/api/state", { headers: auth })).json()).thinkingLevel, "high");
  assert.equal((await post("/api/effort", { effort: "ludicrous" })).status, 400, "unsupported effort rejected");
  assert.equal((await post("/api/model", { model: "anthropic/claude-haiku-4-5" })).status, 200);
  assert.equal((await (await request("/api/state", { headers: auth })).json()).thinkingLevel, "high", "effort kept when the new model supports it");
  const device = await readFile(join(root, 'data/device-id'), 'utf8');
  const login = await request('/?token=' + encodeURIComponent(token), { headers: { host: publicHost }, redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.equal((await request('/api/state', { headers: { ...auth, host: 'alias.example.test:9443' } })).status, 200);
  assert.equal(await upgrade({ cookie: 'pi_trial=' + token, origin: 'https://alias.example.test:9443' }, 'alias.example.test:9443'), 'HTTP/1.1 101 Switching Protocols');
  assert.equal((await request('/api/plugins', { method: 'POST', headers: { ...auth, host: publicHost, origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/', { headers: auth })).status, 200);
  assert.equal(await (await request('/', { headers: auth })).text(), 'PORTABLE_UI_PROXY');
  assert.equal(await upgrade({ origin: publicOriginValue }), 'HTTP/1.1 403 Forbidden');
  assert.equal(await upgrade({ cookie: 'pi_trial=' + token, origin: 'https://evil.test' }), 'HTTP/1.1 403 Forbidden');
  assert.equal(await upgrade({ cookie: 'pi_trial=' + token, origin: publicOriginValue }), 'HTTP/1.1 101 Switching Protocols');
  assert.ok((await stat(join(root, 'data/web-token'))).mode & 0o600);
  await stop();
  await start({ MARS_PI_ROOT: root, XDG_DATA_HOME: join(base, 'unused') });
  const restarted = await (await request('/api/state', { headers: auth })).json();
  assert.equal(restarted.conversationId, state.conversationId);
  assert.equal(await readFile(join(root, 'data/device-id'), 'utf8'), device);
  assert.equal((await readFile(join(root, 'data/web-token'), 'utf8')).trim(), token);
  assert.equal((await request('/api/plugins', { headers: auth })).status, 200);
  console.log('Portable real host boot/restart, XDG and explicit root, auth, exact HTTP/WebSocket origins, configured UI proxy and private persistent identity passed. No model/account calls.');
} finally {
  await stop();
  await new Promise(resolve => ui.close(resolve));
  await rm(base, { recursive: true, force: true });
}
