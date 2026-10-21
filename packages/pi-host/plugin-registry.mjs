import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRegistry } from '@earendil-works/pi-durable';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const humanise = name => name.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function validateFlags(value) {
  if (!object(value)) throw new Error('Plugin settings must be an object');
  for (const key of Object.keys(value)) if (!['enabled', 'uiEnabled', 'tools'].includes(key)) throw new Error(`Unknown plugin setting ${key}`);
  for (const key of ['enabled', 'uiEnabled']) if (key in value && typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if ('tools' in value && (!object(value.tools) || Object.values(value.tools).some(flag => typeof flag !== 'boolean'))) throw new Error('tools must map tool names to booleans');
}

/** These switches control native exposure. Installed source retains full VM authority. */
export async function createPluginRegistry({ root }) {
  const file = join(root, 'plugins.json');
  let settings = { plugins: {} };
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
    if (!object(settings) || Object.keys(settings).some(key => key !== 'plugins') || !object(settings.plugins)) throw new Error('Invalid plugin settings');
    for (const flags of Object.values(settings.plugins)) validateFlags(flags);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const native = createRegistry();
  const definitions = new Map();
  let chain = Promise.resolve();
  function exposed(extension, flags = settings.plugins[extension.name] || {}) {
    if (flags.enabled === false) return { ...extension, tools: [], sections: [], hooks: [], wraps: [] };
    return { ...extension, tools: (extension.tools || []).filter(tool => flags.tools?.[tool.name] !== false) };
  }
  function validateInstall(extension) {
    const probe = createRegistry();
    for (const current of definitions.values()) if (current.name !== extension.name) probe.install(current);
    probe.install(extension);
  }
  const registry = {
    snapshot: () => native.snapshot(),
    subscribe: listener => native.subscribe(listener),
    install(extension) {
      validateInstall(extension);
      definitions.set(extension.name, extension);
      native.install(exposed(extension));
    },
    uninstall(extension) {
      const name = typeof extension === 'string' ? extension : extension.name;
      definitions.delete(name);
      native.uninstall({ name });
    },
  };
  function row(extension) {
    const flags = settings.plugins[extension.name] || {};
    const metadata = extension.marsPlugin || {};
    const enabled = flags.enabled !== false;
    const hasUi = metadata.hasUi === true;
    return {
      name: extension.name, title: metadata.title || humanise(extension.name), description: metadata.description || '',
      ...(metadata.version ? { version: metadata.version } : {}), kind: ['extension', 'mcp'].includes(metadata.kind) ? metadata.kind : 'system',
      enabled, hasUi, uiEnabled: enabled && hasUi && flags.uiEnabled !== false,
      tools: (extension.tools || []).map(tool => ({ name: tool.name, description: tool.description || '', enabled: enabled && flags.tools?.[tool.name] !== false })),
    };
  }
  async function persist(next) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function update(input) {
    if (!object(input)) throw new Error('Plugin update must be an object');
    const { name, ...changes } = input;
    if (typeof name !== 'string' || !definitions.has(name)) throw new Error('Unknown plugin');
    validateFlags(changes);
    const extension = definitions.get(name);
    const toolNames = new Set((extension.tools || []).map(tool => tool.name));
    for (const toolName of Object.keys(changes.tools || {})) if (!toolNames.has(toolName)) throw new Error(`Unknown plugin tool ${toolName}`);
    const previous = settings.plugins[name] || {};
    const flags = { ...previous, ...changes, ...(changes.tools ? { tools: { ...previous.tools, ...changes.tools } } : {}) };
    const next = { plugins: { ...settings.plugins, [name]: flags } };
    // Publish only after persistence succeeds. A failed write must leave tools and UI exposed as before.
    await persist(next);
    settings = next;
    const current = definitions.get(name);
    if (current) native.install(exposed(current));
    return current ? row(current) : undefined;
  }
  return {
    registry,
    list: () => [...definitions.values()].map(row),
    set(input) {
      const copy = structuredClone(input);
      const result = chain.then(() => update(copy));
      chain = result.catch(() => {});
      return result;
    },
    isUiEnabled(name) { const extension = definitions.get(name); return !!extension && row(extension).uiEnabled; },
    /** Every installed tool definition, exposure switches ignored: for the tool-quality check. */
    definitions() { return [...definitions.values()].flatMap(extension => (extension.tools || []).map(tool => ({ extension: extension.name, tool }))); },
  };
}
