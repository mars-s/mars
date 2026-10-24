// Lanes (docs/LANES.md), night fixes: one lock for every process, a merge still running in
// another process is never re-queued, a detached worktree cannot be reported merged, unusual
// file names cannot slip past the guard, a deleted interface module still gets the type check,
// and a crash between merging and installing dependencies still installs them.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLanes, parseNameStatus, withFileLock } from './lanes.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-lanes-night-'));
const repo = join(dir, 'repo'), root = join(dir, 'root');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
await mkdir(join(repo, 'apps/ui/lib'), { recursive: true });
git(dir, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'check@example.com');
git(repo, 'config', 'user.name', 'Check');
await writeFile(join(repo, 'apps/ui/lib/helper.ts'), 'export const x = 1;\n');
await writeFile(join(repo, 'notes.txt'), 'one\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const installs = [];
const make = () => createLanes({ repo, root, dir: join(dir, 'lanes'), previews: false, env: { ...process.env, MARS_PUBLIC_ORIGIN: '' },
  installDependencies: async (cwd) => { installs.push(cwd); return { code: 0, stdout: '', stderr: '' }; } });
const lanes = make();
const passed = [];
try {
  // -z output keeps a tab in a directory name, so the guard sees the real .env path.
  assert.deepEqual(parseNameStatus('A\0secrets\t/.env\0M\0notes.txt\0'), [{ status: 'A', path: 'secrets\t/.env' }, { status: 'M', path: 'notes.txt' }]);
  const quoted = await lanes.start({ title: 'Quoted' });
  await mkdir(join(quoted.worktree, 'secrets\t'), { recursive: true });
  await writeFile(join(quoted.worktree, 'secrets\t/.env'), 'TOKEN=x\n');
  git(quoted.worktree, 'add', '-f', '.');
  git(quoted.worktree, 'commit', '-qm', 'sneaky');
  await assert.rejects(lanes.submit({ id: quoted.id }), /Refused: .*\.env/s);
  await lanes.close({ id: quoted.id });
  passed.push('unusual file names guarded');

  // A detached worktree: its commits are not on the lane branch, so it must not "merge".
  const detached = await lanes.start({ title: 'Detached' });
  git(detached.worktree, 'switch', '-q', '--detach');
  await writeFile(join(detached.worktree, 'notes.txt'), 'two\n');
  await assert.rejects(lanes.submit({ id: detached.id }), /detached HEAD, not lane\//);
  assert.equal(await readFile(join(repo, 'notes.txt'), 'utf8'), 'one\n');
  await lanes.close({ id: detached.id });
  passed.push('detached worktree refused');

  // Deleting an interface module still runs the type check (here it cannot run, so it blocks).
  const deletion = await lanes.start({ title: 'Delete helper' });
  await rm(join(deletion.worktree, 'apps/ui/lib/helper.ts'));
  const blocked = await lanes.submit({ id: deletion.id });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.note, /interface type check/);
  assert.ok(existsSync(join(repo, 'apps/ui/lib/helper.ts')), 'the deletion did not land');
  await lanes.close({ id: deletion.id });
  passed.push('deleted module type checked');

  // Two processes changing lanes at once lose nothing.
  const other = make();
  const started = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? lanes : other).start({ title: 'Many ' + i })));
  const listed = new Set((await make().list()).lanes.map((l) => l.id));
  assert.ok(started.every((l) => listed.has(l.id)), 'every lane started in either process is kept');
  for (const l of started) await lanes.close({ id: l.id });
  passed.push('no lost updates across processes');

  // A merge another live process is running is left alone; a dead runner's merge is recovered.
  const busy = await lanes.start({ title: 'Busy' });
  await writeFile(join(busy.worktree, 'busy.txt'), 'b\n');
  await lanes.pause({ paused: true });
  await lanes.submit({ id: busy.id });
  const file = join(root, 'data/lanes.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.lanes[busy.id].state = 'merging';
  saved.queue = [busy.id];
  saved.paused = false;
  await writeFile(file, JSON.stringify(saved));
  const queueLock = join(root, 'data/lanes-queue.lock');
  await mkdir(queueLock);
  await writeFile(join(queueLock, 'owner'), String(process.pid));
  assert.equal((await make().list()).lanes.find((l) => l.id === busy.id).state, 'merging', 'not re-queued while its runner lives');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  await writeFile(join(queueLock, 'owner'), String(dead));
  const fresh = make();
  assert.equal((await fresh.list()).lanes.find((l) => l.id === busy.id).state, 'queued', 'a dead runner: queued again');
  await fresh.processQueue();
  assert.equal((await fresh.list()).lanes.find((l) => l.id === busy.id).state, 'merged');
  assert.equal(existsSync(queueLock), false, 'the stale lock is gone');
  passed.push('runner lock respected, stale lock recovered');

  // A crash after main moved but before installing dependencies: the next runner installs.
  const deps = await lanes.start({ title: 'Deps' });
  await writeFile(join(deps.worktree, 'package.json'), '{"name":"x"}\n');
  await lanes.pause({ paused: true });
  await lanes.submit({ id: deps.id });
  git(repo, 'merge', '-q', '--ff-only', 'lane/' + deps.id);
  const crashed = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(crashed.lanes[deps.id], { state: 'merging', pendingInstall: true });
  crashed.paused = false;
  await writeFile(file, JSON.stringify(crashed));
  const after = make();
  const recovered = (await after.list()).lanes.find((l) => l.id === deps.id);
  assert.equal(recovered.state, 'merged');
  assert.match(recovered.note, /Dependencies installed/);
  assert.deepEqual(installs, [repo], 'installed once, in the checkout');
  passed.push('pending install resumed');

  // The lock itself: work runs one at a time across instances of it.
  let inside = 0, most = 0;
  await Promise.all(Array.from({ length: 6 }, () => withFileLock(join(dir, 'x.lock'), async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 15)); inside--; })));
  assert.equal(most, 1);
  passed.push('file lock is exclusive');
  console.log('PASS lanes night: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
