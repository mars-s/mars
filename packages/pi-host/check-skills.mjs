// Skills against temporary folders and a local git repository (no network): parsing, the
// first folder winning a name clash, the bounded prompt list, reading files inside a skill
// only, writing Mars's own skills but never the shared ones, and installing from git.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSkills, parseSkill, skillRoots } from './skills.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-skills-'));
const put = async (path, text) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
const skill = (name, description, body = 'Do the thing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

try {
  assert.deepEqual(parseSkill('---\nname: a\ndescription: >-\n  Use when\n  folding.\nother: "x"\n---\nBody').meta, { name: 'a', description: 'Use when folding.', other: 'x' });
  assert.equal(parseSkill('No front matter').body, 'No front matter');

  const home = join(dir, 'home');
  const work = join(dir, 'work');
  await put(join(home, '.agents/skills/grill-me/SKILL.md'), skill('grill-me', 'Use when the owner wants to be interviewed about a plan.'));
  await put(join(home, '.agents/skills/grill-me/references/questions.md'), 'Ask why five times.');
  await put(join(home, '.agents/skills/tdd/SKILL.md'), skill('tdd', 'Use for red green refactor.'));
  await put(join(home, '.claude/skills/tdd/SKILL.md'), skill('tdd', 'A clashing copy that must lose.'));
  await put(join(home, '.agents/skills/no-skill-md/README.md'), 'not a skill');
  await put(join(dir, 'outside.md'), 'secret');
  await symlink(join(dir, 'outside.md'), join(home, '.agents/skills/grill-me/escape.md'));
  const roots = skillRoots({ work, env: { HOME: home }, home });
  assert.deepEqual(roots.map((root) => root.source), ['mars', 'agents', 'claude']);
  const skills = createSkills({ roots, cacheMs: 0 });

  const listed = await skills.list();
  assert.deepEqual(listed.skills.map((row) => [row.name, row.source]), [['grill-me', 'agents'], ['tdd', 'agents']], 'first folder wins, folders without SKILL.md are ignored');
  assert.deepEqual((await skills.list('interviewed plan')).skills.map((row) => row.name), ['grill-me']);
  const prompt = await skills.catalogue();
  assert.match(prompt, /- grill-me: Use when the owner wants to be interviewed/);
  assert.match(prompt, /\/grill-me/);

  const read = await skills.read('/grill-me');
  assert.match(read.text, /Do the thing/);
  assert.deepEqual(read.files, ['escape.md', 'references/questions.md']);
  assert.equal((await skills.read('grill-me', 'references/questions.md')).text, 'Ask why five times.');
  await assert.rejects(skills.read('grill-me', '../tdd/SKILL.md'), /inside the skill folder/);
  await assert.rejects(skills.read('grill-me', 'escape.md'), /inside the skill folder/, 'a symlink out of the skill is refused');
  await assert.rejects(skills.read('nope'), /No skill named/);

  // Writing: Mars's own folder only.
  const made = await skills.create({ name: 'release-notes', description: 'Use when writing release notes.', instructions: '1. Read the changelog.' });
  assert.equal(made.replaced, false);
  assert.match(await readFile(join(work, 'skills/release-notes/SKILL.md'), 'utf8'), /name: release-notes\ndescription: "Use when writing release notes."\n---\n\n1. Read the changelog./);
  assert.equal((await skills.create({ name: 'release-notes', description: 'Use when.', instructions: 'v2' })).replaced, true);
  await assert.rejects(skills.create({ name: 'tdd', description: 'x', instructions: 'y' }), /belongs to agents skills/);
  await assert.rejects(skills.create({ name: 'Bad Name', description: 'x', instructions: 'y' }), /name must be/);

  // Installing from a git repository with two skills and one bad name.
  const repo = join(dir, 'repo');
  await put(join(repo, 'skills/animate/SKILL.md'), skill('animate', 'Use when adding motion.'));
  await put(join(repo, 'skills/animate/scripts/run.sh'), 'echo hi');
  await put(join(repo, 'skills/deep/nested/taste/SKILL.md'), skill('taste', 'Use for visual taste.'));
  await put(join(repo, 'skills/bad/SKILL.md'), skill('Not Valid!', 'x'));
  await run('git', ['init', '-q', repo]);
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'skills']);
  const installed = await skills.install({ source: 'file://' + repo });
  assert.deepEqual(installed.installed.map((row) => row.name).sort(), ['animate', 'taste']);
  assert.equal(installed.skipped.length, 1);
  assert.equal(await readFile(join(work, 'skills/animate/scripts/run.sh'), 'utf8'), 'echo hi', 'extra files come too');
  assert.equal((await skills.install({ source: 'file://' + repo })).installed[0].replaced, true, 'reinstalling replaces');
  assert.deepEqual((await skills.list()).skills.map((row) => row.name), ['animate', 'grill-me', 'release-notes', 'taste', 'tdd']);
  const local = await skills.install({ source: join(repo, 'skills/animate') });
  assert.deepEqual(local.installed.map((row) => row.name), ['animate'], 'a local folder installs');
  await assert.rejects(skills.install({ source: 'not a source' }), /source must be/);
  await assert.rejects(skills.install({ source: join(dir, 'home') + '/.claude/skills/tdd', ref: 'bad ref!' }), /ref must be/);
  await assert.rejects(skills.install({ source: join(dir, 'outside-none') }), /No SKILL.md|ENOENT/);

  // The prompt list stays bounded with a large collection.
  for (let n = 0; n < 400; n++) await put(join(work, `skills/bulk-${n}/SKILL.md`), skill(`bulk-${n}`, 'Use when ' + 'something long happens '.repeat(20)));
  const big = await skills.catalogue();
  assert.ok(big.length < 13500, 'catalogue is bounded: ' + big.length);
  assert.match(big, /more: call skill_list/);
  console.log('PASS skills: front matter, first folder wins, search, bounded prompt list with /name hint, read SKILL.md and files, path and symlink escapes refused, create own only, install from git and a local folder with replace and skips, refusals');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
