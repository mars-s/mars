// Lanes (docs/LANES.md): a merge that changes package.json or package-lock.json installs the
// dependencies in the checkout; other merges do not. Temporary git repository, install stubbed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLanes } from './lanes.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-lanes-deps-'));
const repo = join(dir, 'repo'), root = join(dir, 'root');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
await mkdir(join(repo, 'apps/ui'), { recursive: true });
git(dir, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'check@example.com');
git(repo, 'config', 'user.name', 'Check');
await writeFile(join(repo, 'apps/ui/package.json'), '{"name":"ui"}\n');
await writeFile(join(repo, 'notes.txt'), 'one\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const installs = [];
let failInstall = false;
const lanes = createLanes({ repo, root, dir: join(dir, 'lanes'), previews: false, env: { ...process.env, MARS_PUBLIC_ORIGIN: '' },
  installDependencies: async (cwd) => { installs.push(cwd); return failInstall ? { code: 1, stdout: '', stderr: 'ETARGET' } : { code: 0, stdout: '', stderr: '' }; } });
try {
  const plain = await lanes.start({ title: 'Notes' });
  await writeFile(join(plain.worktree, 'notes.txt'), 'two\n');
  assert.equal((await lanes.submit({ id: plain.id })).state, 'merged');
  assert.deepEqual(installs, [], 'no install without a dependency change');

  const deps = await lanes.start({ title: 'Deps' });
  await writeFile(join(deps.worktree, 'apps/ui/package.json'), '{"name":"ui","dependencies":{"x":"1"}}\n');
  const merged = await lanes.submit({ id: deps.id });
  assert.equal(merged.state, 'merged');
  assert.deepEqual(installs, [repo], 'installed once, in the checkout');
  assert.match(merged.next, /Dependencies installed in the checkout/);

  failInstall = true;
  const broken = await lanes.start({ title: 'Broken deps' });
  await writeFile(join(broken.worktree, 'apps/ui/package.json'), '{"name":"ui","dependencies":{"x":"2"}}\n');
  const result = await lanes.submit({ id: broken.id });
  assert.equal(result.state, 'merged', 'the merge itself stands');
  assert.match(result.note, /npm install in the checkout failed: ETARGET/);
  console.log('PASS lanes deps: no install for plain merges, one install in the checkout after a dependency change, a failed install reported');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
