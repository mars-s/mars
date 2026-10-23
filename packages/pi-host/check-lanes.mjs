// Lanes (docs/LANES.md): worktrees per chat and an ordered merge queue into main. Uses a
// temporary git repository and data root only; previews (systemd and tailscale) are off here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLanes } from './lanes.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-lanes-'));
const repo = join(dir, 'repo'), root = join(dir, 'root');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
await mkdir(join(repo, 'packages/pi-host'), { recursive: true });
git(dir, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'check@example.com');
git(repo, 'config', 'user.name', 'Check');
const put = (base, path, text) => writeFile(join(base, path), text);
await put(repo, 'notes.txt', 'one\ntwo\nthree\n');
await put(repo, 'packages/pi-host/sum.mjs', 'export const sum = (a, b) => a + b;\n');
await put(repo, 'packages/pi-host/check-sum.mjs', "import { sum } from './sum.mjs';\nif (sum(2, 2) !== 4) { console.error('sum is wrong'); process.exit(1); }\n");
await put(repo, 'packages/pi-host/run-checks.mjs', '// protected\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const make = () => createLanes({ repo, root, dir: join(dir, 'lanes'), previews: false, env: { ...process.env, MARS_PUBLIC_ORIGIN: '' } });
let lanes = make();
const subjects = () => git(repo, 'log', '--format=%s', 'main').split('\n');
const passed = [];
try {
  // Two lanes in parallel, merged in the order submitted.
  const a = await lanes.start({ title: 'Lane A' }, 'c1');
  const b = await lanes.start({ title: 'Lane B' }, 'c2');
  assert.notEqual(a.worktree, b.worktree);
  assert.equal(a.conversationId, 'c1');
  await put(a.worktree, 'a.txt', 'a\n');
  await put(b.worktree, 'b.txt', 'b\n');
  assert.equal(existsSync(join(repo, 'a.txt')), false, 'the checkout is untouched while a lane works');
  const rb = await lanes.submit({ id: b.id, message: 'B lands first' });
  assert.equal(rb.state, 'merged', rb.next);
  const ra = await lanes.submit({ id: a.id, message: 'A lands second' });
  assert.equal(ra.state, 'merged', ra.next);
  assert.deepEqual(subjects().slice(0, 2), ['A lands second', 'B lands first']);
  assert.equal(existsSync(a.worktree), false, 'merged worktree removed');
  assert.equal(git(repo, 'branch', '--list', 'lane/*'), '', 'merged branches deleted');
  assert.ok(existsSync(join(repo, 'a.txt')) && existsSync(join(repo, 'b.txt')));
  passed.push('parallel lanes merge in submit order');

  // A conflict blocks only that lane; it resolves in its worktree and submits again.
  const c = await lanes.start({ title: 'Lane C' });
  const d = await lanes.start({ title: 'Lane D' });
  await put(c.worktree, 'notes.txt', 'one\nTWO from C\nthree\n');
  await put(d.worktree, 'notes.txt', 'one\nTWO from D\nthree\n');
  assert.equal((await lanes.submit({ id: c.id })).state, 'merged');
  const rd = await lanes.submit({ id: d.id });
  assert.equal(rd.state, 'blocked');
  assert.match(rd.note, /conflicts with main in notes\.txt/);
  assert.ok(existsSync(d.worktree), 'a blocked lane keeps its worktree');
  assert.equal(git(d.worktree, 'status', '--porcelain'), '', 'the failed rebase was undone');
  try { git(d.worktree, 'rebase', 'main'); } catch { /* the conflict, as expected */ }
  await put(d.worktree, 'notes.txt', 'one\nTWO from C and D\nthree\n');
  git(d.worktree, 'add', 'notes.txt');
  git(d.worktree, 'rebase', '--continue');
  assert.equal((await lanes.submit({ id: d.id })).state, 'merged');
  assert.match(await readFile(join(repo, 'notes.txt'), 'utf8'), /C and D/);
  passed.push('conflict blocks one lane, resolve and resubmit');

  // Protected files are refused at submit.
  const e = await lanes.start({ title: 'Lane E' });
  await put(e.worktree, 'packages/pi-host/run-checks.mjs', 'console.log("ok")\n');
  await assert.rejects(lanes.submit({ id: e.id }), /Refused: packages\/pi-host\/run-checks\.mjs/);
  await lanes.close({ id: e.id });
  passed.push('protected files refused');

  // A host check the change reaches must pass; a syntax error is caught first.
  const f = await lanes.start({ title: 'Lane F' });
  await put(f.worktree, 'packages/pi-host/sum.mjs', 'export const sum = (a, b) => a - b;\n');
  const rf = await lanes.submit({ id: f.id });
  assert.equal(rf.state, 'blocked');
  assert.match(rf.note, /Check failed: check-sum\.mjs: .*sum is wrong/s);
  await put(f.worktree, 'packages/pi-host/sum.mjs', 'export const sum = (a, b) => {\n');
  assert.match((await lanes.submit({ id: f.id })).note, /node --check packages\/pi-host\/sum\.mjs/);
  await put(f.worktree, 'packages/pi-host/sum.mjs', 'export const sum = (a, b) => b + a;\n');
  const ok = await lanes.submit({ id: f.id });
  assert.equal(ok.state, 'merged', ok.next);
  passed.push('reached checks gate the merge');

  // Paused queue: the owner reorders, then resumes.
  await lanes.pause({ paused: true });
  const g = await lanes.start({ title: 'Lane G' });
  const h = await lanes.start({ title: 'Lane H' });
  await put(g.worktree, 'g.txt', 'g\n');
  await put(h.worktree, 'h.txt', 'h\n');
  assert.equal((await lanes.submit({ id: g.id, message: 'G' })).queuePosition, 1);
  assert.equal((await lanes.submit({ id: h.id, message: 'H' })).queuePosition, 2);
  assert.deepEqual((await lanes.order({ ids: [h.id, g.id] })).queue, [h.id, g.id]);
  await lanes.pause({ paused: false });
  await lanes.processQueue();
  assert.deepEqual(subjects().slice(0, 2), ['G', 'H'], 'H merged first, then G');
  assert.equal((await lanes.list()).queue.length, 0);
  passed.push('pause, reorder, resume');

  // An uncommitted edit in the checkout to the same file blocks the fast-forward and survives.
  const w = await lanes.start({ title: 'Lane W' });
  await put(repo, 'g.txt', 'owner edit\n');
  await put(w.worktree, 'g.txt', 'lane edit\n');
  const rw = await lanes.submit({ id: w.id });
  assert.equal(rw.state, 'blocked');
  assert.match(rw.note, /could not fast-forward main/);
  assert.equal(await readFile(join(repo, 'g.txt'), 'utf8'), 'owner edit\n', 'the owner edit is kept');
  git(repo, 'checkout', '--', 'g.txt');
  assert.equal((await lanes.submit({ id: w.id })).state, 'merged');
  passed.push('dirty checkout blocks safely');

  // Recovery: a merge cut short after main moved is recorded as merged; before, it is queued again.
  const r1 = await lanes.start({ title: 'Lane R1' });
  const r2 = await lanes.start({ title: 'Lane R2' });
  await put(r1.worktree, 'r1.txt', '1\n');
  await put(r2.worktree, 'r2.txt', '2\n');
  await lanes.pause({ paused: true });
  await lanes.submit({ id: r1.id });
  await lanes.submit({ id: r2.id });
  git(repo, 'merge', '-q', '--ff-only', 'lane/' + r1.id);
  const file = join(root, 'data/lanes.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.lanes[r1.id].state = 'merging';
  saved.lanes[r2.id].state = 'merging';
  saved.queue = [];
  saved.paused = false;
  await writeFile(file, JSON.stringify(saved));
  lanes = make();
  const after = await lanes.list();
  assert.equal(after.lanes.find((l) => l.id === r1.id).state, 'merged');
  assert.deepEqual(after.queue, [r2.id]);
  await lanes.processQueue();
  assert.equal((await lanes.list()).lanes.find((l) => l.id === r2.id).state, 'merged');
  passed.push('restart recovery');

  // Routes
  assert.equal((await lanes.route('GET', '/api/lanes')).main, 'main');
  assert.equal(await lanes.route('DELETE', '/api/lanes'), undefined);
  console.log('PASS lanes: ' + passed.join(', ') + ', routes');
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
