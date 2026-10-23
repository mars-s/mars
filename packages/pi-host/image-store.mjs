import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const formats = new Map([['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
// The composer's image chip (apps/ui/lib/pi/image-chips.ts), with a host attachment id.
const IMAGE_CHIP = /:image\[([^\]\n]{1,80})\]\{name=([A-Za-z0-9-]{1,80})\}/g;
/** Message text as a person reads it: each image chip becomes "[Image 1]". */
export const plainImageChips = (text) => String(text).replace(IMAGE_CHIP, (_whole, label) => `[${label}]`);

/** Immutable, private normalised images. Receipts are the only browser-facing state. */
export function createImageStore({ root }) {
  if (typeof root !== 'string' || !root) throw new Error('Image store root is required');
  const ready = mkdir(root, { recursive: true, mode: 0o700 }).then(() => chmod(root, 0o700));
  async function immutable(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary);
    }
  }
  async function get(id) {
    if (!validId(id)) throw new Error('Invalid attachment ID');
    await ready;
    const receipt = JSON.parse(await readFile(join(root, `${id}.json`), 'utf8'));
    return { ...receipt, path: join(root, `${id}.webp`) };
  }
  async function add(bytes, { mimeType, name } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('Image bytes are required');
    if (bytes.byteLength > MAX_BYTES) throw new Error('Image exceeds 10 MiB');
    if (!formats.has(mimeType)) throw new Error('Unsupported image MIME type');
    const input = Buffer.from(bytes);
    let metadata;
    let output;
    try {
      metadata = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
      if (metadata.format !== formats.get(mimeType)) throw new Error('Image MIME type does not match its bytes');
      if (!metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384) throw new Error('Image dimensions exceed limit');
      // Decode only the first frame and remove metadata before storing model input.
      output = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
        .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, effort: 4 }).toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new Error(`Invalid image: ${error.message}`);
    }
    if (output.data.length > MAX_BYTES) throw new Error('Normalised image exceeds 10 MiB');
    const id = createHash('sha256').update(output.data).digest('hex');
    const cleanName = typeof name === 'string' ? name.replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) : '';
    const receipt = { id, name: cleanName || 'image.webp', mimeType: 'image/webp', size: output.data.length,
      width: output.info.width, height: output.info.height, url: `/api/attachments/${id}` };
    await ready;
    await immutable(join(root, `${id}.webp`), output.data);
    await immutable(join(root, `${id}.json`), JSON.stringify(receipt));
    const { path: _path, ...stored } = await get(id);
    return stored;
  }
  // An image the owner placed in the text is a chip, ":image[Image 1]{name=<id>}"
  // (docs/IMAGE-CHIPS.md). Each image goes where its chip is; the rest follow the text.
  async function content(ids = [], text = '') {
    if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => !validId(id))) throw new Error('Expected at most four attachment IDs');
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate attachment IDs');
    if (typeof text !== 'string') throw new Error('Message text must be a string');
    const attachments = [];
    const blocks = [];
    const placed = new Set();
    // A chip for an image that is not attached reads as its label.
    const words = (piece) => piece.replace(IMAGE_CHIP, (_whole, label) => `[${label}]`);
    const addText = (piece) => { if (piece.trim()) blocks.push({ type: 'text', text: words(piece) }); };
    const addImage = async (id, label = '') => {
      const { path, ...receipt } = await get(id);
      placed.add(id);
      attachments.push(receipt);
      blocks.push({ type: 'text', text: `Attachment ${id}: ${receipt.name}${label ? ` [${label}]` : ''}` });
      blocks.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: receipt.mimeType });
    };
    let from = 0;
    for (const match of text.matchAll(IMAGE_CHIP)) {
      const [whole, label, id] = match;
      if (!ids.includes(id) || placed.has(id)) continue;
      addText(text.slice(from, match.index).trim());
      await addImage(id, label);
      from = match.index + whole.length;
    }
    if (from === 0) { if (text) blocks.push({ type: 'text', text: words(text) }); }
    else addText(text.slice(from).trim());
    for (const id of ids) if (!placed.has(id)) await addImage(id);
    return { content: blocks, attachments };
  }
  function browserView(view) {
    function copy(value) {
      if (Array.isArray(value)) return value.map(copy);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !(value.type === 'image' && key === 'data'))
        .map(([key, item]) => [key, copy(item)]));
    }
    return copy(view);
  }
  return { add, get, content, browserView };
}
