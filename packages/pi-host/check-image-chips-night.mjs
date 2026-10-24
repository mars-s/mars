// Image chips, night fix (docs/IMAGE-CHIPS.md): identical images (one host id) placed by two
// chips go in both places, each with its label; the receipt is listed once.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImageStore } from './image-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'mars-image-chips-night-'));
try {
  const store = createImageStore({ root });
  const one = await store.add(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer(), { mimeType: 'image/png', name: 'same.png' });
  const placed = await store.content([one.id], 'Compare :image[Image 1]{name=' + one.id + '} with :image[Image 2]{name=' + one.id + '}');
  assert.deepEqual(placed.content.map((b) => (b.type === 'image' ? 'image' : b.text)), [
    'Compare', 'Attachment ' + one.id + ': same.png [Image 1]', 'image', 'with', 'Attachment ' + one.id + ': same.png [Image 2]', 'image',
  ]);
  assert.equal(placed.attachments.length, 1, 'one receipt');
  console.log('PASS image chips night: one image placed by two chips goes in both places, receipt once');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
