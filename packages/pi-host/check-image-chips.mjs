// Images placed in the text (docs/IMAGE-CHIPS.md): each image goes where its chip is, labelled,
// with unplaced images after the text and chips for missing images left as their label.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImageStore, plainImageChips } from './image-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'mars-image-chips-'));
const shape = (blocks) => blocks.map((block) => (block.type === 'image' ? 'image' : block.text));
try {
  const store = createImageStore({ root });
  const make = (r) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer();
  const one = await store.add(await make(10), { mimeType: 'image/png', name: 'cat.png' });
  const two = await store.add(await make(200), { mimeType: 'image/png', name: 'style.png' });
  const three = await store.add(await make(90), { mimeType: 'image/png', name: 'extra.png' });
  const text = 'Make this :image[Image 1]{name=' + one.id + '} look like :image[Image 2]{name=' + two.id + '}, please.';

  const placed = await store.content([two.id, one.id, three.id], text);
  assert.deepEqual(shape(placed.content), [
    'Make this',
    'Attachment ' + one.id + ': cat.png [Image 1]', 'image',
    'look like',
    'Attachment ' + two.id + ': style.png [Image 2]', 'image',
    ', please.',
    'Attachment ' + three.id + ': extra.png', 'image',
  ]);
  assert.deepEqual(placed.attachments.map((a) => a.name), ['cat.png', 'style.png', 'extra.png'], 'receipts follow the images');

  // A chip whose image was not attached reads as its label; with no chips the text is unchanged.
  const missing = await store.content([one.id], 'See :image[Image 1]{name=' + one.id + '} and :image[Image 2]{name=' + two.id + '}');
  assert.deepEqual(shape(missing.content), ['See', 'Attachment ' + one.id + ': cat.png [Image 1]', 'image', 'and [Image 2]']);
  assert.deepEqual(shape((await store.content([one.id], 'Old style')).content), ['Old style', 'Attachment ' + one.id + ': cat.png', 'image']);
  assert.deepEqual(shape((await store.content([], 'Only [Image 3] :image[Image 3]{name=abc}')).content), ['Only [Image 3] [Image 3]']);
  // A message that is only an image chip.
  assert.deepEqual(shape((await store.content([one.id], ':image[Image 1]{name=' + one.id + '}')).content), ['Attachment ' + one.id + ': cat.png [Image 1]', 'image']);
  assert.equal(plainImageChips(text), 'Make this [Image 1] look like [Image 2], please.');
  console.log('PASS image chips: images where their chips are, labels kept, unplaced images last, missing chips as labels, titles plain');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
