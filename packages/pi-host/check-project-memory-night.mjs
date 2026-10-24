// Project instructions and memory, night fixes (docs/PROJECTS.md, docs/AGENTS-AND-HOOKS.md):
// an AGENTS.md or CLAUDE.md that links out of the repository is not read, a FIFO or a huge file
// never hangs or floods the host, concurrent memory_update calls keep every note, the owner's
// hand-written lines in MEMORY.md survive an update, notes are matched as shown, an unreadable
// MEMORY.md is refused rather than overwritten, the Memory section is bounded, and one plugin
// file named by two SessionStart groups is added once. Temporary folders only; no model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProjects } from './project.mjs';
import { MEMORY_MAX, createMemory } from './memory.mjs';
import { createSessionHooks } from './hooks.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-project-night-'));
const put = async (path, text) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' did not finish in ' + ms + ' ms')), ms))]);
const projects = createProjects({ harness: () => undefined, work: dir, context: undefined });
const results = [];
async function test(name, body) {
  try { await body(); results.push([name, true]); } catch (error) { results.push([name, false]); console.error('FAIL ' + name + ': ' + (error?.message ?? error)); }
}
const repo = async (name) => { const path = join(dir, name); await mkdir(path, { recursive: true }); await run('git', ['init', '-q', path]); return path; };

await test('1 instruction file linking out of the repository is skipped', async () => {
  const root = await repo('linked');
  await put(join(dir, 'secret.txt'), 'FAKE_SECRET=sk-test-123');
  await put(join(root, 'docs/rules.md'), 'Rules kept inside the repo.');
  await symlink('../secret.txt', join(root, 'AGENTS.md'));
  await symlink('docs/rules.md', join(root, 'CLAUDE.md'));
  const files = await projects.instructions(root);
  assert.ok(!JSON.stringify(files).includes('FAKE_SECRET'), 'a link out of the repository is never read');
  assert.deepEqual(files, [['CLAUDE.md', 'Rules kept inside the repo.']], 'a link inside the repository still works');
});

await test('2a FIFO instruction file is skipped without hanging', async () => {
  const root = await repo('fifo');
  await run('mkfifo', [join(root, 'AGENTS.md')]);
  await put(join(root, 'CLAUDE.md'), 'Claude rules.');
  try {
    const files = await within(projects.instructions(root), 2000, 'reading a FIFO AGENTS.md');
    assert.deepEqual(files, [['CLAUDE.md', 'Claude rules.']]);
  } finally {
    // Release a reader stuck on the FIFO (old code) so this check can exit.
    await open(join(root, 'AGENTS.md'), constants.O_WRONLY | constants.O_NONBLOCK).then((fh) => fh.close(), () => {});
  }
});

await test('2b huge instruction file is read only up to its cap', async () => {
  const root = await repo('huge');
  const path = join(root, 'AGENTS.md');
  await put(path, 'Rule one.\n');
  await truncate(path, 600 * 1024 * 1024);
  const files = await within(projects.instructions(root), 3000, 'reading a 600 MB AGENTS.md');
  assert.equal(files.length, 1);
  assert.ok(files[0][1].startsWith('Rule one.'));
  assert.match(files[0][1], /Cut at 12000 characters/);
  assert.ok(files[0][1].length < 12200, 'cut to the cap');
});

await test('3 concurrent memory updates keep every note', async () => {
  const work = join(dir, 'memory-concurrent');
  const memory = createMemory({ work });
  const settled = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => memory.update({ add: ['note ' + n] })));
  assert.deepEqual(settled.map((s) => s.status), Array(5).fill('fulfilled'), settled.map((s) => s.reason?.code ?? s.status).join(' '));
  assert.deepEqual((await memory.notes()).sort(), ['note 1', 'note 2', 'note 3', 'note 4', 'note 5']);
  assert.equal(settled.at(-1).value.notes.length, 5, 'the last update reports every note');
});

await test('4a hand-written lines in MEMORY.md survive an update', async () => {
  const work = join(dir, 'memory-hand');
  const memory = createMemory({ work });
  const hand = '# My memory\n\n## Work\n\n1. Deploy only at the end\n2. Use pnpm\n\nA paragraph the owner wrote.\n\n- a  b\n- old note\n';
  await put(memory.file, hand);
  await memory.update({ add: ['x'], remove: ['old note'] });
  const text = await readFile(memory.file, 'utf8');
  for (const line of ['# My memory', '## Work', '1. Deploy only at the end', '2. Use pnpm', 'A paragraph the owner wrote.', '- a  b', '- x']) assert.ok(text.includes(line), 'kept ' + line + ' in ' + JSON.stringify(text));
  assert.ok(!text.includes('old note'), 'the removed note is gone');
});

await test('4b a note is removed by the text it is shown with', async () => {
  const work = join(dir, 'memory-spaces');
  const memory = createMemory({ work });
  await put(memory.file, '- a  b\n- keep\n');
  const result = await memory.update({ remove: ['a  b'] });
  assert.equal(result.notFound, undefined, 'found the note');
  assert.deepEqual(await memory.notes(), ['keep']);
});

await test('4c an unreadable MEMORY.md is refused, not overwritten', async () => {
  if (process.getuid?.() === 0) return; // root reads any file; nothing to prove
  const work = join(dir, 'memory-unreadable');
  const memory = createMemory({ work });
  await put(memory.file, '- precious note\n');
  await chmod(memory.file, 0o000);
  try {
    await assert.rejects(memory.update({ add: ['new'] }), /MEMORY\.md/);
  } finally { await chmod(memory.file, 0o644); }
  assert.equal(await readFile(memory.file, 'utf8'), '- precious note\n');
});

await test('5 the Memory section is bounded', async () => {
  const work = join(dir, 'memory-big');
  const memory = createMemory({ work });
  await put(memory.file, Array.from({ length: 50 }, (_, n) => '- ' + String(n).padStart(2, '0') + ' ' + 'y'.repeat(400)).join('\n') + '\n');
  const section = await memory.render();
  assert.ok(section.length <= MEMORY_MAX + 200, 'section is ' + section.length + ' characters');
  assert.match(section, /\(\d+ more notes left out/);
  assert.ok(section.includes('- 00 '), 'the first notes are shown');
});

await test('6 one plugin SessionStart file is added once', async () => {
  const home = join(dir, 'hooks-home');
  const root = join(home, 'plugins/dup');
  await put(join(root, 'hooks/start.md'), 'DUPLICATE NOTE');
  const command = 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/start.md"';
  await put(join(root, 'hooks/hooks.json'), JSON.stringify({ hooks: { SessionStart: [
    { matcher: '*', hooks: [{ type: 'command', command }, { type: 'command', command }] },
    { matcher: 'startup', hooks: [{ type: 'command', command }] },
  ] } }));
  const hooks = createSessionHooks({ work: join(dir, 'hooks-work'), home, plugins: async () => [{ name: 'dup', root }], cacheMs: 0 });
  const section = await hooks.section();
  assert.equal(section.split('DUPLICATE NOTE').length - 1, 1, 'the note appears once');
});

for (const [name, ok] of results) console.log((ok ? 'PASS ' : 'FAIL ') + name);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'PASS project and memory night fixes: ' + results.length + ' checks');
process.exit(failed ? 1 : 0);
