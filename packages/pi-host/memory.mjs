// Memory notes (docs/PROJECTS.md "Memory"): a short Markdown list of things the owner wants
// remembered across every conversation, kept in <workspace>/MEMORY.md and added to each prompt.
// The file is the only store, so the owner can edit it by hand too.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';

export const MEMORY_MAX = 8000;
const NOTE_MAX = 500;
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (note) => String(note).replace(/\s+/g, ' ').trim();

export function createMemory({ work }) {
  const file = join(work, 'MEMORY.md');
  async function notes() {
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch { return []; }
    return text.split('\n').map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim()).filter(Boolean);
  }
  async function save(list) {
    const text = '# Memory\n\nThings Mars remembers in every conversation. Edit freely; one note per line.\n\n' + list.map((note) => `- ${note}`).join('\n') + '\n';
    if (text.length > MEMORY_MAX) throw fail(`Memory would be ${text.length} characters; the limit is ${MEMORY_MAX}. Remove or shorten notes first.`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.tmp', text);
    await rename(file + '.tmp', file);
  }
  return {
    file,
    notes,
    async render() {
      const list = await notes();
      if (!list.length) return undefined;
      return ['## Memory', '', 'The owner asked you to remember these. Keep them in mind; change them with memory_update.', '', ...list.map((note) => `- ${note}`)].join('\n');
    },
    async update({ add = [], remove = [] }) {
      const list = await notes();
      const drop = new Set(remove.map((note) => clean(note).toLowerCase()));
      const missing = [...drop].filter((note) => !list.some((row) => row.toLowerCase() === note));
      const kept = list.filter((row) => !drop.has(row.toLowerCase()));
      for (const note of add.map(clean)) {
        if (!note) continue;
        if (note.length > NOTE_MAX) throw fail(`A note is ${note.length} characters; keep each under ${NOTE_MAX}.`);
        if (!kept.some((row) => row.toLowerCase() === note.toLowerCase())) kept.push(note);
      }
      await save(kept);
      return { notes: kept, ...(missing.length ? { notFound: missing } : {}) };
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
