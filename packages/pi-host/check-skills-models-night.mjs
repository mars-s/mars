// Skills and model settings, night fixes: quoted descriptions read back as written, a skill at a
// repository root takes the repository's name, relative links inside a skill survive install,
// installing "foo" leaves a skill named "foo.previous" alone, and changing the default model
// clears an effort that belonged to the old one. Temporary folders and a local git repo only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSkills, parseSkill, skillRoots } from './skills.mjs';
import { createModelSettings } from './model-settings.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-skills-night-'));
const put = async (path, text) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
const passed = [];
try {
  assert.equal(parseSkill('---\nname: a\ndescription: "Use for \\"quoted\\" words and a \\\\ backslash"\n---\n').meta.description, 'Use for "quoted" words and a \\ backslash');
  assert.equal(parseSkill("---\nname: a\ndescription: 'It''s single'\n---\n").meta.description, "It's single");
  const home = join(dir, 'home'), work = join(dir, 'work');
  const skills = createSkills({ roots: skillRoots({ work, env: { HOME: home }, home }), cacheMs: 0 });
  await skills.create({ name: 'quoter', description: 'Use for "automate me" requests', instructions: 'Go.' });
  assert.equal((await skills.list('automate')).skills[0].description, 'Use for "automate me" requests');
  passed.push('quoted descriptions');

  // A repository whose root is the skill, with no name: and a relative link inside it.
  const repo = join(dir, 'my-skill');
  await put(join(repo, 'SKILL.md'), '---\ndescription: Use for the night check.\n---\nRead alias.md.\n');
  await put(join(repo, 'refs/a.md'), 'the reference');
  await symlink('refs/a.md', join(repo, 'alias.md'));
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'skill']);
  // An existing skill whose name ends in .previous must survive installing "my-skill".
  await skills.create({ name: 'my-skill.previous', description: 'Use for keeping.', instructions: 'Keep me.' });
  const installed = await skills.install({ source: 'file://' + repo });
  assert.deepEqual(installed.installed.map((row) => row.name), ['my-skill'], 'named after the repository, not "repo"');
  const read = await skills.read('my-skill', 'alias.md');
  assert.match(JSON.stringify(read), /the reference/, 'the relative link still resolves');
  await skills.install({ source: 'file://' + repo });
  assert.ok((await skills.list()).skills.some((row) => row.name === 'my-skill.previous'), 'a skill named my-skill.previous is kept');
  passed.push('install: repo name, relative links, no stray .previous deletes');

  const file = join(dir, 'model-settings.json');
  const settings = createModelSettings({ file, resolve: (id) => ['a', 'b'].includes(id) });
  await settings.set({ defaultModel: 'a' });
  await settings.set({ defaultEffort: 'max' });
  assert.equal((await settings.get()).defaultEffort, 'max');
  assert.equal((await settings.set({ defaultModel: 'b' })).defaultEffort, '', 'a new default model clears the old effort');
  assert.equal((await settings.set({ defaultModel: 'a', defaultEffort: 'low' })).defaultEffort, 'low', 'unless an effort comes with it');
  assert.equal((await settings.set({ defaultModel: 'a' })).defaultEffort, 'low', 'the same model keeps its effort');
  assert.equal((await settings.set({ defaultModel: '' })).defaultEffort, '', '"Same as the chat" clears it too');
  passed.push('effort follows its model');
  console.log('PASS skills and models night: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
