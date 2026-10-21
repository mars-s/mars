// Starts a fake Telegram, a real Pi host for checks (staging, echo model, temporary data
// root) and a dev UI pointed at it, then prints the values gateway-live-flow-check needs.
// Nothing here reaches a real platform or model. Ctrl+C stops all three.
//   node scripts/gateway-live-preview.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../dev-tools.mjs';
import { fakeTelegram } from '../gateway/fakes.mjs';

const token = '123456:' + 'P'.repeat(30);
const owner = '9990001';
const telegram = await fakeTelegram({ token, control: true });
const base = await mkdtemp(join(tmpdir(), 'mars gateway preview '));
const hostPort = await freePort(), uiPort = await freePort();
const host = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
  cwd: base, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MARS_PI_ROOT: join(base, 'data'), MARS_PI_PORT: String(hostPort), MARS_UI_PORT: String(uiPort), MARS_PI_STAGING: '1', MARS_ECHO_MODEL: '1',
    MARS_GATEWAY_FAKE: '1', MARS_GATEWAY_TELEGRAM: '1', MARS_TELEGRAM_TOKEN: token, MARS_TELEGRAM_API: telegram.baseUrl, MARS_TELEGRAM_OWNER: owner, MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' },
});
let log = '';
host.stdout.on('data', (d) => (log += d));
host.stderr.on('data', (d) => (log += d));
for (let n = 0; n < 300 && !log.includes('agent ready'); n++) await new Promise((r) => setTimeout(r, 100));
if (!log.includes('agent ready')) throw Error('host did not start: ' + log.slice(-1000));
const webToken = (await readFile(join(base, 'data/data/web-token'), 'utf8')).trim();
const uiDir = process.env.MARS_GATEWAY_UI_DIR || fileURLToPath(new URL('../../../apps/ui/', import.meta.url));
// Pass MARS_GATEWAY_UI_DIR to run the UI from another checkout (for example a worktree)
// when a dev server already holds this checkout's .next lock.
const ui = spawn(process.execPath, ['scripts/next.mjs', 'dev'], { cwd: uiDir, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MARS_PI_ORIGIN: `http://127.0.0.1:${hostPort}`, MARS_PI_TOKEN: webToken, MARS_UI_PORT: String(uiPort) } });
let uiLog = '';
ui.stdout.on('data', (d) => (uiLog += d));
ui.stderr.on('data', (d) => (uiLog += d));
let uiReady = false;
for (let n = 0; n < 600 && !uiReady; n++) {
  try { uiReady = (await fetch(`http://127.0.0.1:${uiPort}/`)).ok; } catch {}
  if (!uiReady) await new Promise((r) => setTimeout(r, 200));
}
if (!uiReady) { console.error('UI did not start:\n' + uiLog.slice(-2000)); ui.kill(); host.kill(); process.exit(1); }
console.log(JSON.stringify({ MARS_UI_BASE_URL: `http://127.0.0.1:${uiPort}/`, MARS_GATEWAY_FAKE_TELEGRAM: telegram.baseUrl, MARS_GATEWAY_FAKE_TOKEN: token, MARS_GATEWAY_OWNER: owner }));
const stop = () => { ui.kill('SIGTERM'); host.kill('SIGTERM'); telegram.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
