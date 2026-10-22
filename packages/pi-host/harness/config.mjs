// Harness config versions (docs/HARNESS-LOOP.md). A version is the text around the frozen
// model: the system guide, per-tool description overrides and context notes. Its id is a
// hash of that content, so the same text always gets the same id and any edit gets a new
// one. Files under configs/ are written once and never changed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = fileURLToPath(new URL('./configs/', import.meta.url));

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};

/** First 12 hex characters of the SHA-256 of `value` in canonical JSON (keys sorted). */
export const hashOf = (value) => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12);

const contentOf = ({ parent = null, systemGuide, toolOverrides = {}, contextNotes = '' }) => {
  if (typeof systemGuide !== 'string' || !systemGuide.trim()) throw Error('A harness config needs a non-empty systemGuide');
  if (typeof contextNotes !== 'string') throw Error('contextNotes must be a string');
  for (const [name, text] of Object.entries(toolOverrides)) {
    if (typeof text !== 'string' || !text.trim()) throw Error(`Override for ${name} must be a non-empty description`);
  }
  return { parent, systemGuide, toolOverrides: { ...toolOverrides }, contextNotes };
};

export function makeConfig(fields) {
  const content = contentOf(fields);
  Object.freeze(content.toolOverrides);
  return Object.freeze({ id: hashOf(content), ...content });
}

/** Throws when `config.id` is not the hash of its content, e.g. after a hand edit. */
export function verifyConfig(config) {
  const expected = hashOf(contentOf(config));
  if (config.id !== expected) throw Error(`Harness config ${config.id} does not match its content (hash ${expected})`);
  return config;
}

export async function saveConfig(config, dir = CONFIG_DIR) {
  verifyConfig(config);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${config.id}.json`);
  try {
    await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await loadConfig(config.id, dir);
  }
  return file;
}

export async function loadConfig(id, dir = CONFIG_DIR) {
  const config = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
  if (config.id !== id) throw Error(`File ${id}.json holds config ${config.id}`);
  return makeConfigChecked(config);
}

const makeConfigChecked = (config) => {
  verifyConfig(config);
  return makeConfig(config);
};

/** Tool rows with this config's description overrides applied. An override for a tool that does not exist is an error. */
export function applyOverrides(rows, config) {
  const names = new Set(rows.map((row) => row.name));
  for (const name of Object.keys(config.toolOverrides)) if (!names.has(name)) throw Error(`Override names unknown tool ${name}`);
  return rows.map((row) => (config.toolOverrides[row.name] ? { ...row, description: config.toolOverrides[row.name] } : row));
}

export const systemMessage = (config) => [config.systemGuide.trim(), config.contextNotes.trim()].filter(Boolean).join('\n\n');
