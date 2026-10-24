// Lane locks, second night pass: a lock whose pid now belongs to another process (reused after a
// crash or a reboot) is stale; two processes taking over one stale lock never both hold it; a
// process only removes its own lock; and a queue another process held is retried later.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLanes, withFileLock } from './lanes.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-lane-locks-'));
const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const passed = [];
const plant = async (path, line) => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'owner'), line); };
const take = (path) => withFileLock(path, async () => 'ran', { wait: false });
try {
  // pid 1 is always running (another user's process): only its start time says it is not ours.
  await plant(join(dir, 'a.lock'), '1 ' + boot + ' 999999999 x');
  assert.equal((await take(join(dir, 'a.lock'))).held, true, 'a reused pid is stale');
  await plant(join(dir, 'b.lock'), process.pid + ' 00000000-0000-0000-0000-000000000000 1 x');
  assert.equal((await take(join(dir, 'b.lock'))).held, true, 'another boot is stale');
  const stats = (await readFile('/proc/1/stat', 'utf8'));
  const realStart = stats.slice(stats.lastIndexOf(')') + 2).split(' ')[19];
  await plant(join(dir, 'c.lock'), '1 ' + boot + ' ' + realStart + ' x');
  assert.equal((await take(join(dir, 'c.lock'))).held, false, 'a live owner is not stale');
  passed.push('reused pids and reboots');

  // Many processes' worth of takers on one stale lock: one at a time, every round.
  for (let round = 0; round < 20; round++) {
    const path = join(dir, 'race' + round + '.lock');
    await plant(path, '999999 ' + boot + ' 1 dead');
    let inside = 0, most = 0;
    await Promise.all(Array.from({ length: 6 }, () => withFileLock(path, async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 5)); inside--; })));
    assert.equal(most, 1, 'round ' + round + ': two holders at once');
  }
  passed.push('stale takeover is exclusive');

  // A lock taken over while its first holder works is not removed by that first holder.
  const path = join(dir, 'own.lock');
  await withFileLock(path, async () => { await writeFile(join(path, 'owner'), '1 ' + boot + ' ' + realStart + ' someone-else'); });
  assert.ok(await stat(path).then(() => true, () => false), 'the new owner keeps its lock');
  passed.push('only its own lock is released');

  // The queue: held by a live owner when a lane is submitted, retried once that owner is done.
  const repo = join(dir, 'repo'), root = join(dir, 'root');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await mkdir(repo, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'c@e.com'); git(repo, 'config', 'user.name', 'C');
  await writeFile(join(repo, 'a.txt'), '1\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const lanes = createLanes({ repo, root, dir: join(dir, 'lanes'), previews: false, retryMs: 300, env: { ...process.env, MARS_PUBLIC_ORIGIN: '' } });
  const lane = await lanes.start({ title: 'Later' });
  await writeFile(join(lane.worktree, 'a.txt'), '2\n');
  await plant(join(root, 'data/lanes-queue.lock'), '1 ' + boot + ' ' + realStart + ' busy');
  const queued = await lanes.submit({ id: lane.id });
  assert.equal(queued.state, 'queued', 'waits while another runner holds the queue');
  await rm(join(root, 'data/lanes-queue.lock'), { recursive: true, force: true });
  let state = '';
  for (let n = 0; n < 100 && state !== 'merged'; n++) { await new Promise((r) => setTimeout(r, 100)); state = (await lanes.list()).lanes.find((l) => l.id === lane.id)?.state; }
  assert.equal(state, 'merged', 'retried without another submit');
  passed.push('queue retried later');
  console.log('PASS lane locks night: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
