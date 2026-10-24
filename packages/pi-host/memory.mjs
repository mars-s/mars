// Memory notes (docs/PROJECTS.md "Memory"): a short Markdown list of things the owner wants
// remembered across every conversation, kept in <workspace>/MEMORY.md and added to each prompt.
// The file is the only store, so the owner can edit it by hand too.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';

export const MEMORY_MAX = 8000;
const NOTE_MAX = 500;
const HEADER = '# Memory\n\nThings Mars remembers in every conversation. Edit freely; one note per line.\n';
const NOTE = /^\s*[-*]\s+(.*)$/;
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (note) => String(note).replace(/\s+/g, ' ').trim();
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
// One update at a time per file, so concurrent memory_update calls never lose a note.
const queues = new Map();

export function createMemory({ work }) {
  const file = join(work, 'MEMORY.md');
  /** The file as lines, [] when it does not exist. Any other read error is thrown, never read as empty. */
  async function lines() {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw Object.assign(new Error(`MEMORY.md could not be read (${error.code ?? error.message}); it was left as it is.`), { status: 500 });
    }
    const out = text.split('\n');
    if (out.at(-1) === '') out.pop();
    return out;
  }
  const noteOf = (line) => NOTE.exec(line)?.[1]?.trim() || '';
  async function notes() {
    return (await lines()).map(noteOf).filter(Boolean);
  }
  async function write(text) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text);
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
  async function change({ add = [], remove = [] }) {
    const before = await lines();
    const asked = [...new Map(remove.map((note) => [clean(note).toLowerCase(), clean(note)])).values()].filter(Boolean);
    const missing = asked.filter((note) => !before.some((line) => noteOf(line) && same(noteOf(line), note)));
    // Only note lines that were asked for go; headings, numbered lists and paragraphs stay as written.
    const after = before.filter((line) => !(noteOf(line) && asked.some((note) => same(noteOf(line), note))));
    const fresh = [];
    for (const note of add.map(clean)) {
      if (!note) continue;
      if (note.length > NOTE_MAX) throw fail(`A note is ${note.length} characters; keep each under ${NOTE_MAX}.`);
      if (![...after.map(noteOf).filter(Boolean), ...fresh].some((row) => same(row, note))) fresh.push(note);
    }
    // New notes go after the last note line, or at the end.
    let at = after.length;
    while (at > 0 && !noteOf(after[at - 1])) at--;
    if (!at) {
      if (!before.length) after.push(...HEADER.trimEnd().split('\n'));
      if (fresh.length && after.length && after.at(-1).trim()) after.push('');
      at = after.length;
    }
    after.splice(at, 0, ...fresh.map((note) => `- ${note}`));
    const text = after.length ? after.join('\n') + '\n' : '';
    const old = before.length ? before.join('\n') + '\n' : '';
    // A file already over the limit (edited by hand) may still shrink.
    if (text.length > MEMORY_MAX && text.length > old.length) throw fail(`Memory would be ${text.length} characters; the limit is ${MEMORY_MAX}. Remove or shorten notes first.`);
    if (text !== old) await write(text);
    return { notes: after.map(noteOf).filter(Boolean), ...(missing.length ? { notFound: missing } : {}) };
  }
  return {
    file,
    notes,
    async render() {
      let list;
      try { list = await notes(); } catch { return undefined; }
      if (!list.length) return undefined;
      const shown = [];
      let used = 0;
      for (const note of list) {
        const line = `- ${note}`;
        if (used + line.length + 1 > MEMORY_MAX) break;
        shown.push(line);
        used += line.length + 1;
      }
      const left = list.length - shown.length;
      return ['## Memory', '', 'The owner asked you to remember these. Keep them in mind; change them with memory_update.', '', ...shown, ...(left ? ['', `(${left} more notes left out: over ${MEMORY_MAX} characters. Read MEMORY.md for the rest.)`] : [])].join('\n');
    },
    update(args) {
      const next = (queues.get(file) ?? Promise.resolve()).then(() => change(args));
      const settled = next.catch(() => {});
      queues.set(file, settled);
      settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
      return next;
    },
  };
}

export function createMemoryExtension({ memory }) {
  return defineExtension({
    name: 'mars-memory',
    sections: [section('memory', () => memory.render(), { tag: false })],
    tools: [
      defineTool({
        name: 'memory_update',
        description: `Remember a fact or preference in every future conversation, or forget one.
Use it when the owner says "remember ...", "from now on ...", or corrects a habit you should keep. Notes are short single lines shown in the Memory section of every prompt. To change a note, remove the old text and add the new. It returns all notes. For longer how-to instructions, write a skill with skill_create instead.
Example: await tools.memory_update({ add: ["The owner prefers Australian English and no em dashes."] })`,
        parameters: Type.Object({
          add: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500, description: 'One short note, e.g. "Deploy only once, at the end of a batch."' }), { maxItems: 20, description: 'Notes to add, up to 20. Duplicates are ignored.' })),
          remove: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500, description: 'The exact text of a note to remove (case does not matter).' }), { maxItems: 20, description: 'Notes to remove, up to 20.' })),
        }),
        structuredOutputSchema: Type.Object({
          notes: Type.Array(Type.String(), { description: 'Every note now remembered.' }),
          notFound: Type.Optional(Type.Array(Type.String(), { description: 'Notes asked to remove that did not exist.' })),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => {
          const value = await memory.update(args);
          return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
        },
      }),
    ],
  });
}
