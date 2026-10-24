// Security night fixes: an empty owner token is replaced at boot and never matches an empty
// cookie or header; any pi_trial cookie that is the token signs in, so a planted one cannot lock
// the owner out; and repeated image chips cannot multiply one image into thousands of blocks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { freePort } from './dev-tools.mjs';
import { createImageStore } from './image-store.mjs';

const base = await mkdtemp(join(tmpdir(), 'mars-security-night-'));
const root = join(base, 'root');
await mkdir(join(root, 'data'), { recursive: true });
await writeFile(join(root, 'data/web-token'), '  \n');
const port = await freePort(), uiPort = await freePort();
let log = '';
const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  cwd: base, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MARS_PI_ROOT: root, MARS_PI_PORT: String(port), MARS_UI_PORT: String(uiPort), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '', MARS_PI_STAGING: '1', MARS_LANES_DISABLED: '1' },
});
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const passed = [];
try {
  for (let n = 0; n < 300 && !log.includes('agent ready'); n++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('agent ready'), 'host boots: ' + log.slice(-2000));
  const token = (await readFile(join(root, 'data/web-token'), 'utf8')).trim();
  assert.ok(token.length >= 32, 'a blank token file gets a new token');
  const get = (headers) => fetch('http://127.0.0.1:' + port + '/api/host/version', { headers }).then((r) => r.status);
  assert.equal(await get({ cookie: 'pi_trial=' }), 401, 'an empty cookie is not the owner');
  assert.equal(await get({ authorization: 'Bearer ' }), 401, 'an empty header is not the owner');
  assert.equal(await get({ authorization: 'Bearer ' + token }), 200);
  passed.push('empty token');
  assert.equal(await get({ cookie: 'pi_trial=planted; pi_trial=' + token }), 200, 'a planted cookie sent first does not lock the owner out');
  assert.equal(await get({ cookie: 'pi_trial=planted; other=' + token }), 401);
  passed.push('planted cookie');

  const store = createImageStore({ root: join(base, 'images') });
  const image = await store.add(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer(), { mimeType: 'image/png', name: 'x.png' });
  const flood = Array.from({ length: 1250 }, (_, i) => ':image[x' + i + ']{name=' + image.id + '}').join(' ');
  const content = await store.content([image.id], flood);
  const images = content.content.filter((block) => block.type === 'image').length;
  assert.ok(images <= 4, 'at most four placements, got ' + images);
  passed.push('image placements capped');
  console.log('PASS security night: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await rm(base, { recursive: true, force: true });
}
