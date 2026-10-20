import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImageStore } from './image-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'mars-image-check-'));
try {
  const store = createImageStore({ root });
  const png = await sharp({ create: { width: 3000, height: 1200, channels: 4, background: { r: 240, g: 20, b: 80, alpha: 0.4 } } }).png().toBuffer();
  const receipt = await store.add(png, { mimeType: 'image/png', name: 'colours.png' });
  assert.equal(receipt.width, 2048);
  assert.equal(receipt.height, 819);
  assert.equal(receipt.name, 'colours.png');
  assert.match(receipt.id, /^[a-f0-9]{64}$/);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const restarted = createImageStore({ root });
  const stored = await restarted.get(receipt.id);
  assert.equal((await stat(stored.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, `${receipt.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await sharp(await readFile(stored.path)).metadata()).hasAlpha, true);
  assert.deepEqual(await restarted.add(png, { mimeType: 'image/png', name: 'renamed.png' }), receipt);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => store.add(png, { mimeType: 'image/png', name: 'race.png' }))), Array(5).fill(receipt));
  const message = await restarted.content([receipt.id], 'Inspect this');
  assert.equal(message.content[0].text, 'Inspect this');
  assert.equal(message.content[2].type, 'image');
  assert.deepEqual(Buffer.from(message.content[2].data, 'base64'), await readFile(stored.path));
  assert.deepEqual((await restarted.content([], 'hello')).content, [{ type: 'text', text: 'hello' }]);
  const view = { entries: [{ kind: 'mars.user', data: { attachments: message.attachments }, content: message.content }] };
  const browser = restarted.browserView(view);
  assert.equal(browser.entries[0].content[2].data, undefined);
  assert.deepEqual(browser.entries[0].data.attachments, [receipt]);
  assert(message.content[2].data.length > 0, 'snapshot conversion must not mutate native input');
  const huge = structuredClone(view);
  huge.entries[0].content[2].data = 'a'.repeat(2_000_000);
  assert.equal(JSON.stringify(restarted.browserView(huge)).length, JSON.stringify(browser).length);
  assert(JSON.stringify(browser).length < 1500);
  await assert.rejects(store.get('../../secret'), /Invalid attachment/);
  await assert.rejects(store.get('0'.repeat(64)), /ENOENT/);
  await assert.rejects(store.add(png, { mimeType: 'image/jpeg' }), /does not match/);
  await assert.rejects(store.add(png, { mimeType: 'image/svg\+xml' }), /Unsupported/);
  await assert.rejects(store.add(Buffer.from('broken'), { mimeType: 'image/png' }), /Invalid image/);
  await assert.rejects(store.add(Buffer.alloc(10 * 1024 * 1024 + 1), { mimeType: 'image/png' }), /10 MiB/);
  await assert.rejects(store.content(Array(5).fill(receipt.id)), /at most four/);
  await assert.rejects(store.content([receipt.id, receipt.id]), /Duplicate/);
  const oversized = await sharp({ create: { width: 17000, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(store.add(oversized, { mimeType: 'image/png' }), /dimensions/);
  const pixels = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(store.add(pixels, { mimeType: 'image/png' }), /pixel limit/);
  for (const [format, mimeType] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']]) {
    const bytes = await sharp({ create: { width: 12, height: 9, channels: 3, background: 'blue' } })[format]().toBuffer();
    const item = await store.add(bytes, { mimeType, name: '../image' });
    assert.equal(item.width, 12);
    assert.equal(item.name, 'image');
  }
  console.log('PASS image store: real formats, alpha, size limits, private persistence, restart, idempotency and bounded snapshots');
} finally {
  await rm(root, { recursive: true, force: true });
}
