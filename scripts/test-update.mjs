// Updater behaviour (docs/UPDATES.md) against real temporary Git repositories. Services,
// npm, the Next build, the test boot and health are fakes that record what they were asked.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify } from './update-check.mjs';
import { createUpdater } from './update.mjs';

const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'mars' }, 'packages/pi-host': { name: '@mars/pi-host' }, 'apps/ui': { name: 'mars-ui' } } });
const BASE = {
  'package.json': JSON.stringify({ name: 'mars', workspaces: ['apps/ui', 'packages/pi-host'] }),
  'package-lock.json': LOCK,
  '.gitignore': 'node_modules/\n.next-build/\n',
  'packages/pi-host/package.json': JSON.stringify({ name: '@mars/pi-host', dependencies: { a: '1.0.0' } }),
  'packages/pi-host/server.mjs': 'export const version = 1;\n',
  'packages/pi-host/run-checks.mjs': 'export const gate = 1;\n',
  'apps/ui/package.json': JSON.stringify({ name: 'mars-ui' }),
  'apps/ui/page.txt': 'one\ntwo\nthree\n',
  'scripts/build.mjs': 'export {};\n',
};

/** origin (bare), an upstream clone to push from, and the installed checkout. */
async function fixture(run, { ops: extra = {}, managed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mars update '));
  try {
    const origin = join(dir, 'origin.git'), upstream = join(dir, 'upstream'), repo = join(dir, 'install'), root = join(dir, 'data');
    sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    sh(dir, 'clone', '-q', origin, upstream);
    await put(upstream, BASE);
    sh(upstream, 'add', '.'); sh(upstream, 'commit', '-qm', 'base'); sh(upstream, 'push', '-q', 'origin', 'main');
    sh(dir, 'clone', '-q', origin, repo);
    sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 'T');
    await mkdir(join(repo, 'node_modules/a'), { recursive: true });
    await writeFile(join(repo, 'node_modules/a/version'), 'installed');
    await put(join(repo, 'apps/ui/.next-build'), { BUILD_ID: 'old' });
    await put(join(root, 'app'), { 'server.mjs': 'export const version = 1;\n', 'live-only.json': '{"kept":true}' });
    const calls = [];
    const health = { ok: true };
    const ops = {
      managed: async () => managed,
      insideService: async () => false,
      portsInUse: async () => [],
      stop: async () => { calls.push('stop'); },
      start: async () => { calls.push('start'); },
      health: async () => { calls.push('health'); return health.ok ? { ok: true, detail: 'fake healthy' } : { ok: false, detail: 'fake unhealthy' }; },
      install: async tree => { calls.push('install'); await put(tree, { 'node_modules/a/version': 'new' }); return { code: 0, output: '' }; },
      // The fake build records the page it was built from, to prove which tree was built.
      build: async tree => { calls.push('build'); await put(tree, { 'apps/ui/.next-build/BUILD_ID': await readFile(join(tree, 'apps/ui/page.txt'), 'utf8') }); return { code: 0, output: 'built' }; },
      bootTest: async () => { calls.push('boot'); return { ok: true, detail: 'fake boot' }; },
      checks: async () => { calls.push('checks'); return { ok: true, detail: '' }; },
      ...extra,
    };
    const config = { repo, root, ui: join(repo, 'apps/ui'), hostPort: '1', uiPort: '2', hostService: 'h.service', uiService: 'u.service' };
    const updater = createUpdater(config, { ops, env: {} });
    const push = async (files, message = 'upstream change') => { sh(upstream, 'pull', '-q', '--ff-only'); await put(upstream, files); sh(upstream, 'add', '.'); sh(upstream, 'commit', '-qm', message); sh(upstream, 'push', '-q', 'origin', 'main'); };
    const commit = async (files, message = 'local change') => { await put(repo, files); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', message); };
    await run({ dir, repo, root, upstream, updater, calls, health, push, commit, config, head: () => sh(repo, 'rev-parse', 'HEAD') });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const read = path => readFile(path, 'utf8');

test('classify: every state from plain facts', () => {
  const base = { isRepo: true, fetched: true, remote: 'origin', branch: 'main', head: 'a', target: 'b', currentBranch: 'main', ahead: 0, behind: 1, uncommitted: [], untracked: [], updateChanges: ['x'], updateAdds: [], conflicts: [] };
  assert.equal(classify({ ...base, head: 'b', behind: 0 }).state, 'up_to_date');
  assert.equal(classify({ ...base, behind: 0, ahead: 2 }).state, 'ahead');
  assert.equal(classify(base).state, 'fast_forward');
  assert.equal(classify({ ...base, ahead: 1, mergeClean: true }).state, 'merge');
  assert.equal(classify({ ...base, ahead: 1, reconciled: 'c' }).state, 'merge');
  const conflict = classify({ ...base, ahead: 1, mergeClean: false, conflicts: ['f'] });
  assert.equal(conflict.state, 'needs_reconcile'); assert.deepEqual(conflict.blockers[0].files, ['f']);
  assert.equal(classify({ ...base, isRepo: false }).blockers[0].code, 'not_git');
  assert.equal(classify({ ...base, fetched: false, fetchError: 'offline' }).blockers[0].code, 'no_remote');
  assert.equal(classify({ ...base, operation: 'rebase' }).blockers[0].code, 'operation_in_progress');
  assert.equal(classify({ ...base, currentBranch: null }).blockers[0].code, 'detached');
  assert.equal(classify({ ...base, currentBranch: 'dev' }).blockers[0].code, 'wrong_branch');
  assert.equal(classify({ ...base, deployInProgress: true }).blockers[0].code, 'deploy_in_progress');
  assert.deepEqual(classify({ ...base, uncommitted: ['x', 'y'] }).blockers[0].files, ['x']);
  assert.equal(classify({ ...base, uncommitted: ['y'] }).state, 'fast_forward');
  assert.deepEqual(classify({ ...base, untracked: ['n'], updateAdds: ['n'] }).blockers[0].files, ['n']);
});

test('up to date and ahead install nothing', () => fixture(async ({ updater, commit, calls }) => {
  assert.equal((await updater.check()).status.state, 'up_to_date');
  await commit({ 'local.txt': 'mine' });
  const { status } = await updater.check();
  assert.equal(status.state, 'ahead'); assert.equal(status.ahead, 1);
  assert.equal((await updater.apply()).outcome, 'nothing_to_do');
  assert.deepEqual(calls, []);
}));

test('fast-forward: builds beside the live copy, swaps, restarts, keeps live-only runtime files', () => fixture(async ({ repo, root, updater, push, calls, head }) => {
  await push({ 'apps/ui/page.txt': 'one\nTWO\nthree\n', 'packages/pi-host/server.mjs': 'export const version = 2;\n' }, 'Version two');
  const { status } = await updater.check();
  assert.equal(status.state, 'fast_forward'); assert.equal(status.behind, 1); assert.match(status.commits[0], /Version two/);
  const before = head();
  const result = await updater.apply();
  assert.equal(result.outcome, 'updated', JSON.stringify(result));
  assert.notEqual(head(), before);
  assert.equal(head(), execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.deepEqual(calls, ['build', 'boot', 'stop', 'start', 'health'], 'no npm install: dependencies unchanged');
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'one\nTWO\nthree\n', 'new UI build installed');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 2;\n', 'new host runtime installed');
  assert.equal(await read(join(root, 'app/live-only.json')), '{"kept":true}');
  assert.equal(await readlink(join(root, 'app/node_modules')), join(repo, 'node_modules'));
  assert.equal(await read(join(repo, 'node_modules/a/version')), 'installed');
  assert.equal(JSON.parse(await read(join(root, 'updates/installed.json'))).commit, head());
  assert.equal((await updater.check()).status.state, 'up_to_date');
  const state = await updater.read();
  assert.equal(state.last.outcome, 'updated'); assert.equal(state.running, null);
}));

test('changed dependencies are installed in the new tree and swapped in', () => fixture(async ({ repo, updater, push, calls }) => {
  await push({ 'packages/pi-host/package.json': JSON.stringify({ name: '@mars/pi-host', dependencies: { a: '2.0.0' } }) });
  assert.equal((await updater.apply()).outcome, 'updated');
  assert.ok(calls.includes('install'));
  assert.equal(await read(join(repo, 'node_modules/a/version')), 'new');
  // A scripts-only package.json change does not reinstall.
  calls.length = 0;
  await push({ 'apps/ui/package.json': JSON.stringify({ name: 'mars-ui', scripts: { x: 'y' } }) });
  assert.equal((await updater.apply()).outcome, 'updated');
  assert.ok(!calls.includes('install'));
}));

test('local commits that merge cleanly become a merge commit; nothing is reset', () => fixture(async ({ repo, updater, push, commit, head }) => {
  await commit({ 'apps/ui/page.txt': 'ONE\ntwo\nthree\n' }, 'Self edit');
  await push({ 'apps/ui/page.txt': 'one\ntwo\nTHREE\n' });
  const mine = head();
  const { status } = await updater.check();
  assert.equal(status.state, 'merge'); assert.equal(status.ahead, 1);
  assert.equal((await updater.apply()).outcome, 'updated');
  assert.equal(await read(join(repo, 'apps/ui/page.txt')), 'ONE\ntwo\nTHREE\n');
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim().split(' ');
  assert.equal(parents[1], mine);
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'ONE\ntwo\nTHREE\n', 'built from the merged result');
  assert.equal((await updater.check()).status.state, 'ahead', 'the merge commit is local until the owner pushes it');
}));

test('a real conflict needs reconcile and changes nothing', () => fixture(async ({ repo, updater, push, commit, head, calls }) => {
  await commit({ 'apps/ui/page.txt': 'one\nmine\nthree\n' });
  await push({ 'apps/ui/page.txt': 'one\ntheirs\nthree\n' });
  const before = head();
  const { status } = await updater.check();
  assert.equal(status.state, 'needs_reconcile');
  assert.deepEqual(status.blockers[0].files, ['apps/ui/page.txt']);
  assert.equal((await updater.apply()).outcome, 'nothing_to_do');
  assert.equal(head(), before); assert.deepEqual(calls, []);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
}));

test('uncommitted changes: overlapping blocks, others are kept and built', () => fixture(async ({ repo, root, updater, push }) => {
  await push({ 'apps/ui/page.txt': 'one\ntwo\nTHREE\n' });
  await writeFile(join(repo, 'apps/ui/page.txt'), 'local edit\n');
  const blocked = (await updater.check()).status;
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blockers[0].code, 'local_changes_overlap');
  assert.deepEqual(blocked.blockers[0].files, ['apps/ui/page.txt']);
  execFileSync('git', ['checkout', '--', 'apps/ui/page.txt'], { cwd: repo });
  await writeFile(join(repo, 'packages/pi-host/server.mjs'), 'export const version = "local";\n');
  await writeFile(join(repo, 'packages/pi-host/new-local.mjs'), 'export {};\n');
  assert.equal((await updater.apply()).outcome, 'updated');
  assert.equal(await read(join(repo, 'packages/pi-host/server.mjs')), 'export const version = "local";\n', 'uncommitted edit kept');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = "local";\n', 'the running host has the uncommitted edit');
  assert.ok(existsSync(join(root, 'app/new-local.mjs')), 'and the untracked file');
  assert.equal(await read(join(repo, 'apps/ui/page.txt')), 'one\ntwo\nTHREE\n');
}));

test('an untracked file in the way blocks', () => fixture(async ({ repo, updater, push }) => {
  await push({ 'apps/ui/added.txt': 'from main' });
  await writeFile(join(repo, 'apps/ui/added.txt'), 'mine');
  const { status } = await updater.check();
  assert.equal(status.blockers[0].code, 'untracked_overwritten');
}));

test('wrong branch, unfinished merge, failed fetch and a running deploy block', () => fixture(async ({ dir, repo, root, updater, push }) => {
  await push({ 'apps/ui/x.txt': '1' });
  sh(repo, 'switch', '-q', '-c', 'feature');
  assert.equal((await updater.check()).status.blockers[0].code, 'wrong_branch');
  sh(repo, 'switch', '-q', 'main');
  await writeFile(join(repo, '.git/MERGE_HEAD'), sh(repo, 'rev-parse', 'HEAD') + '\n');
  assert.equal((await updater.check()).status.blockers[0].code, 'operation_in_progress');
  await rm(join(repo, '.git/MERGE_HEAD'));
  await put(join(root, 'deploys/20261022T000000-abc'), { 'status.json': JSON.stringify({ status: 'applying', at: new Date().toISOString() }) });
  assert.equal((await updater.check()).status.blockers[0].code, 'deploy_in_progress');
  await rm(join(root, 'deploys'), { recursive: true });
  sh(repo, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  const offline = (await updater.check()).status;
  assert.equal(offline.blockers[0].code, 'no_remote'); assert.match(offline.blockers[0].message, /missing\.git|does not appear|not found/i);
}));

test('a failed build changes nothing live', () => fixture(async ({ repo, root, updater, push, head, calls }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const before = head();
  const result = await updater.apply();
  assert.equal(result.outcome, 'failed'); assert.match(result.detail, /^build: UI build failed: boom/);
  assert.equal(head(), before);
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 1;\n');
  assert.ok(!calls.includes('stop'));
}, { ops: { build: async () => ({ code: 1, output: 'boom' }) } }));

test('a syntax error in the incoming host code fails before anything stops', () => fixture(async ({ updater, push, head, calls }) => {
  await push({ 'packages/pi-host/server.mjs': 'export const = ;\n' });
  const before = head();
  const result = await updater.apply();
  assert.equal(result.outcome, 'failed'); assert.match(result.detail, /^syntax: packages\/pi-host\/server\.mjs/);
  assert.equal(head(), before); assert.ok(!calls.includes('build') && !calls.includes('stop'));
}));

test('a failed test boot fails before anything stops', () => fixture(async ({ updater, push, calls }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  assert.match((await updater.apply()).detail, /^boot: crashed/);
  assert.ok(!calls.includes('stop'));
}, { ops: { bootTest: async () => ({ ok: false, detail: 'crashed' }) } }));

test('full runs the host checks, and a failure stops before anything changes', () => fixture(async ({ updater, push, calls, head }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const first = await updater.apply();
  assert.equal(first.steps.find(step => step.name === 'checks').status, 'skipped');
  assert.ok(!calls.includes('checks'));
  const installed = head();
  await push({ 'apps/ui/page.txt': 'newer\n' });
  calls.length = 0;
  const result = await updater.apply({ full: true });
  assert.match(result.detail, /^checks: Host checks failed: 2 failed/);
  assert.deepEqual(calls, ['build', 'boot'], 'nothing stopped');
  assert.equal(head(), installed);
}, { ops: { checks: async () => ({ ok: false, detail: '2 failed' }) } }));

test('unhealthy new version, unhealthy old version: rollback_failed, files still put back', () => fixture(async ({ repo, root, updater, push, health, calls, head }) => {
  await push({ 'apps/ui/page.txt': 'bad\n', 'packages/pi-host/server.mjs': 'export const version = "bad";\n', 'packages/pi-host/package.json': JSON.stringify({ name: '@mars/pi-host', dependencies: { a: '9' } }) });
  await writeFile(join(repo, 'scripts/local.mjs'), 'export {};\n');
  const before = head();
  health.ok = false;
  const result = await updater.apply();
  assert.equal(result.outcome, 'rollback_failed');
  assert.match(result.detail, /^health: fake unhealthy \| rollback: old version unhealthy too/);
  assert.equal(head(), before);
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 1;\n');
  assert.equal(await read(join(repo, 'node_modules/a/version')), 'installed');
  assert.equal(await read(join(repo, 'apps/ui/page.txt')), 'one\ntwo\nthree\n');
  assert.ok(existsSync(join(repo, 'scripts/local.mjs')), 'untracked local file kept');
  assert.deepEqual(calls.slice(-4), ['health', 'stop', 'start', 'health']);
}));

test('unhealthy new version, healthy old version: rolled_back', () => fixture(async ({ repo, updater, push, health, head }) => {
  await push({ 'apps/ui/page.txt': 'bad\n' });
  const before = head();
  const result = await updater.apply();
  assert.equal(result.outcome, 'rolled_back', JSON.stringify(result));
  assert.equal(head(), before);
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
  assert.match(result.next, /old one is running again/);
  assert.equal((await updater.check()).status.state, 'fast_forward', 'the update is still offered');
  void health;
}, { ops: (() => { let n = 0; return { health: async () => (++n === 1 ? { ok: false, detail: 'new one crashed' } : { ok: true, detail: 'old one fine' }) }; })() }));

test('a failed service start counts as unhealthy and is rolled back', () => fixture(async ({ updater, push, head }) => {
  await push({ 'apps/ui/page.txt': 'bad\n' });
  const before = head();
  const result = await updater.apply();
  assert.equal(result.outcome, 'rolled_back'); assert.match(result.detail, /^start: unit failed/);
  assert.equal(head(), before);
}, { ops: (() => { let n = 0; return { start: async () => { if (++n === 1) throw Error('unit failed'); } }; })() }));

test('one update at a time', () => fixture(async ({ root, updater, push }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  await mkdir(join(root, 'updates'), { recursive: true });
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await writeFile(join(root, 'updates/.lock'), JSON.stringify({ pid: sleeper.pid, id: 'other' }));
    assert.equal((await updater.apply()).outcome, 'busy');
  } finally { sleeper.kill(); }
  await new Promise(resolve => sleeper.once('close', resolve));
  assert.equal((await updater.apply()).outcome, 'updated', 'a lock left by a dead process is taken over');
}));

test('not a service and Mars is running: refuses; stopped: updates without restarting', () => fixture(async ({ updater, push }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const refused = await updater.apply();
  assert.equal(refused.outcome, 'refused'); assert.match(refused.detail, /Stop Mars/);
}, { managed: false, ops: { portsInUse: async () => ['1'] } }));

test('not a service and stopped: updates and says to start Mars', () => fixture(async ({ updater, push, calls }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const result = await updater.apply();
  assert.equal(result.outcome, 'updated'); assert.equal(result.restarted, false); assert.match(result.next, /Start Mars again/);
  assert.ok(!calls.includes('stop') && !calls.includes('start'));
}, { managed: false }));

test('an update killed while switching over is undone by recover()', () => fixture(async ({ repo, root, updater, push, head, config }) => {
  await push({ 'apps/ui/page.txt': 'new\n', 'packages/pi-host/server.mjs': 'export const version = 2;\n' });
  const before = head();
  // Run the real CLI in a child that dies (SIGKILL) as soon as the runtime swap starts.
  const script = `
    import { createUpdater } from ${JSON.stringify(fileURLToPath(new URL('./update.mjs', import.meta.url)))};
    const config = ${JSON.stringify(config)};
    const ops = { managed: async () => true, insideService: async () => false, stop: async () => {}, start: async () => {},
      health: async () => ({ ok: true }), build: async tree => { const fs = await import('node:fs/promises'); await fs.mkdir(tree + '/apps/ui/.next-build', { recursive: true }); await fs.writeFile(tree + '/apps/ui/.next-build/BUILD_ID', 'new'); return { code: 0, output: '' }; },
      bootTest: async () => ({ ok: true, detail: '' }) };
    const updater = createUpdater(config, { ops, env: {}, log: line => { if (line.startsWith('swap_runtime')) process.kill(process.pid, 'SIGKILL'); } });
    await updater.apply();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const signal = await new Promise(resolve => child.once('close', (_code, sig) => resolve(sig)));
  assert.equal(signal, 'SIGKILL');
  assert.notEqual(head(), before, 'the child moved the checkout before it died');
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'new');
  const journal = JSON.parse(await read(join(root, 'updates/current.json')));
  assert.equal(journal.phase, 'switching');
  assert.equal((await updater.read()).running, null, 'a dead updater is not reported as running');
  const recovered = await updater.recover();
  assert.equal(recovered.outcome, 'interrupted', JSON.stringify(recovered));
  assert.equal(head(), before);
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 1;\n');
  assert.equal(await updater.recover(), null, 'recovering again does nothing');
  assert.equal((await updater.apply()).outcome, 'updated', 'and the next update works');
}));

test('recover() leaves a live update alone', () => fixture(async ({ root, updater }) => {
  await put(join(root, 'updates'), { 'current.json': JSON.stringify({ id: 'x', phase: 'switching', steps: [] }), '.lock': JSON.stringify({ pid: process.pid, id: 'x' }) });
  assert.equal(await updater.recover({ wait: false }), null);
}));

test('reconcile: markers and a mixed protected file are refused, then the result installs', () => fixture(async ({ repo, root, updater, push, commit, head }) => {
  await commit({ 'apps/ui/page.txt': 'one\nmine\nthree\n', 'packages/pi-host/run-checks.mjs': 'export const gate = "mine";\n' });
  await push({ 'apps/ui/page.txt': 'one\ntheirs\nthree\n', 'packages/pi-host/run-checks.mjs': 'export const gate = "theirs";\n' });
  const mine = head();
  const started = await updater.reconcileStart();
  assert.equal(started.started, true);
  assert.deepEqual(started.conflicts.sort(), ['apps/ui/page.txt', 'packages/pi-host/run-checks.mjs']);
  assert.equal(head(), mine, 'the checkout is untouched');
  const markers = await updater.reconcileFinish();
  assert.equal(markers.ok, false); assert.match(markers.problems.map(p => p.detail).join(), /conflict markers/);
  await writeFile(join(started.worktree, 'apps/ui/page.txt'), 'one\nmine and theirs\nthree\n');
  await writeFile(join(started.worktree, 'packages/pi-host/run-checks.mjs'), 'export const gate = "weaker";\n');
  const mixed = await updater.reconcileFinish();
  assert.equal(mixed.ok, false); assert.match(mixed.problems[0].detail, /protected/);
  execFileSync('git', ['checkout', 'MERGE_HEAD', '--', 'packages/pi-host/run-checks.mjs'], { cwd: started.worktree });
  const finished = await updater.reconcileFinish();
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const { status } = await updater.check();
  assert.equal(status.state, 'merge'); assert.equal(status.reconciled, true);
  assert.equal((await updater.apply()).outcome, 'updated');
  assert.equal(head(), finished.commit);
  assert.equal(await read(join(repo, 'apps/ui/page.txt')), 'one\nmine and theirs\nthree\n');
  assert.ok(!existsSync(join(root, 'updates/reconcile')), 'reconcile worktree removed after install');
}));

test('reconcile is stale once main moves again', () => fixture(async ({ updater, push, commit }) => {
  await commit({ 'apps/ui/page.txt': 'one\nmine\nthree\n' });
  await push({ 'apps/ui/page.txt': 'one\ntheirs\nthree\n' });
  const started = await updater.reconcileStart();
  await writeFile(join(started.worktree, 'apps/ui/page.txt'), 'one\nboth\nthree\n');
  assert.equal((await updater.reconcileFinish()).ok, true);
  await push({ 'apps/ui/other.txt': 'more' });
  assert.equal((await updater.check()).status.state, 'needs_reconcile', 'the old reconcile no longer fits the target');
}));

// Review fixes (an independent review proved each of these against the first version).

test('a commit made during the build: the switch-over refuses before stopping anything', async () => {
  let commitDuringBuild;
  await fixture(async ({ repo, root, updater, push, head, calls }) => {
    await push({ 'apps/ui/page.txt': 'new\n' });
    commitDuringBuild = async () => { await writeFile(join(repo, 'mine.txt'), 'owner work\n'); sh(repo, 'add', 'mine.txt'); sh(repo, 'commit', '-qm', 'Owner commit during build'); };
    const result = await updater.apply();
    assert.equal(result.outcome, 'failed', JSON.stringify(result));
    assert.match(result.detail, /^verify: The checkout got a new commit/);
    assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'Owner commit during build', 'the owner commit is still on main');
    assert.equal(await read(join(repo, 'mine.txt')), 'owner work\n');
    assert.ok(!calls.includes('stop'), 'nothing was stopped');
    assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
    assert.ok(!existsSync(join(repo, 'apps/ui/.next-build.incoming-' + result.id)), 'staged build discarded');
    assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 1;\n');
    void head;
  }, { ops: { build: async tree => { await commitDuringBuild(); await put(tree, { 'apps/ui/.next-build/BUILD_ID': 'new' }); return { code: 0, output: '' }; } } });
});

test('undo never resets a branch the update did not move', () => fixture(async ({ repo, updater, push, head }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const before = head();
  // The health check fails after someone else committed on top of the updated checkout.
  const result = await createUpdater({ repo, root: join(dirname(repo), 'data'), ui: join(repo, 'apps/ui'), hostPort: '1', uiPort: '2', hostService: 'h', uiService: 'u' }, {
    env: {},
    ops: {
      managed: async () => true, insideService: async () => false, stop: async () => {}, start: async () => {},
      build: async tree => { await put(tree, { 'apps/ui/.next-build/BUILD_ID': 'new' }); return { code: 0, output: '' }; },
      bootTest: async () => ({ ok: true, detail: '' }),
      health: async () => { if (sh(repo, 'log', '-1', '--format=%s') !== 'After update') { await writeFile(join(repo, 'later.txt'), 'x'); sh(repo, 'add', 'later.txt'); sh(repo, 'commit', '-qm', 'After update'); } return { ok: false, detail: 'unhealthy' }; },
    },
  }).apply();
  assert.equal(result.outcome, 'rollback_failed');
  assert.match(result.detail, /left as it is/);
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'After update', 'the later commit survives');
  void before; void updater;
}));

test('killed after a healthy switch-over: recover finishes forwards, never mixes versions', () => fixture(async ({ repo, root, updater, push, head, config }) => {
  await push({ 'apps/ui/page.txt': 'new\n', 'packages/pi-host/server.mjs': 'export const version = 2;\n' });
  const script = `
    import { createUpdater } from ${JSON.stringify(fileURLToPath(new URL('./update.mjs', import.meta.url)))};
    const ops = { managed: async () => true, insideService: async () => false, stop: async () => {}, start: async () => {},
      health: async () => ({ ok: true, detail: 'ok' }), build: async tree => { const fs = await import('node:fs/promises'); await fs.mkdir(tree + '/apps/ui/.next-build', { recursive: true }); await fs.writeFile(tree + '/apps/ui/.next-build/BUILD_ID', 'new'); return { code: 0, output: '' }; },
      bootTest: async () => ({ ok: true, detail: '' }) };
    const updater = createUpdater(${JSON.stringify(config)}, { ops, env: {}, log: line => { if (line.startsWith('cleanup')) process.kill(process.pid, 'SIGKILL'); } });
    await updater.apply();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  assert.equal(await new Promise(resolve => child.once('close', (_c, sig) => resolve(sig))), 'SIGKILL');
  const target = sh(repo, 'rev-parse', 'origin/main');
  assert.equal(JSON.parse(await read(join(root, 'updates/current.json'))).phase, 'committed');
  const recovered = await updater.recover();
  assert.equal(recovered.outcome, 'updated', JSON.stringify(recovered));
  assert.equal(head(), target, 'the checkout stays on the new version');
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'new');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 2;\n');
  assert.equal(JSON.parse(await read(join(root, 'updates/installed.json'))).commit, target);
}));

test('killed after the runtime swap: every part, including the runtime, goes back', () => fixture(async ({ repo, root, updater, push, head, config }) => {
  await push({ 'apps/ui/page.txt': 'new\n', 'packages/pi-host/server.mjs': 'export const version = 2;\n', 'packages/pi-host/package.json': JSON.stringify({ name: '@mars/pi-host', dependencies: { a: '3' } }) });
  const before = head();
  const script = `
    import { createUpdater } from ${JSON.stringify(fileURLToPath(new URL('./update.mjs', import.meta.url)))};
    const fs = await import('node:fs/promises');
    const ops = { managed: async () => true, insideService: async () => false, stop: async () => {}, start: async () => {},
      health: async () => ({ ok: true }), install: async tree => { await fs.mkdir(tree + '/node_modules/a', { recursive: true }); await fs.writeFile(tree + '/node_modules/a/version', 'new'); return { code: 0, output: '' }; },
      build: async tree => { await fs.mkdir(tree + '/apps/ui/.next-build', { recursive: true }); await fs.writeFile(tree + '/apps/ui/.next-build/BUILD_ID', 'new'); return { code: 0, output: '' }; },
      bootTest: async () => ({ ok: true, detail: '' }) };
    const updater = createUpdater(${JSON.stringify(config)}, { ops, env: {}, log: line => { if (line.startsWith('start')) process.kill(process.pid, 'SIGKILL'); } });
    await updater.apply();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  assert.equal(await new Promise(resolve => child.once('close', (_c, sig) => resolve(sig))), 'SIGKILL');
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 2;\n', 'the child got as far as swapping the runtime');
  assert.equal((await updater.recover()).outcome, 'interrupted');
  assert.equal(head(), before);
  assert.equal(await read(join(root, 'app/server.mjs')), 'export const version = 1;\n');
  assert.equal(await read(join(repo, 'apps/ui/.next-build/BUILD_ID')), 'old');
  assert.equal(await read(join(repo, 'node_modules/a/version')), 'installed');
  const leftovers = (await readdir(dirname(join(root, 'app')))).filter(name => /\.(prev|incoming|failed)-/.test(name));
  assert.deepEqual(leftovers, []);
}));

test('apply settles an interrupted update first, and a reboot frees a stale lock', () => fixture(async ({ repo, root, updater, push, head }) => {
  await push({ 'apps/ui/page.txt': 'new\n' });
  const before = head();
  await put(join(root, 'updates'), {
    'current.json': JSON.stringify({ id: '20261022T000000Z-dead', phase: 'switching', step: 'stop', from: before, steps: [{ name: 'stop', status: 'done' }] }),
    // pid 1 is alive, but this lock is from a boot an hour ago.
    '.lock': JSON.stringify({ pid: 1, boot: Math.round(Date.now() / 60000) - 60, nonce: 'old', id: 'x' }),
  });
  const first = await updater.apply();
  assert.equal(first.outcome, 'interrupted', JSON.stringify(first));
  assert.match(first.next, /settled first/);
  assert.equal((await updater.apply()).outcome, 'updated');
  void repo;
}));

test('two processes taking over a dead lock: exactly one wins', () => fixture(async ({ root, config }) => {
  await put(join(root, 'updates'), { '.lock': JSON.stringify({ pid: 999999, nonce: 'dead', id: 'x' }) });
  const script = `
    import { createUpdater } from ${JSON.stringify(fileURLToPath(new URL('./update.mjs', import.meta.url)))};
    const u = createUpdater(${JSON.stringify(config)}, { env: {}, ops: { managed: async () => false, portsInUse: async () => [] } });
    try { console.log(JSON.stringify(await u.recover({ wait: true }))); } catch (error) { console.log('ERROR ' + error.stack); }`;
  // Use the lock through recover() with a journal in progress, from 6 processes at once.
  await put(join(root, 'updates'), { 'current.json': JSON.stringify({ id: 'race', phase: 'switching', step: 'stop', from: sh(config.repo, 'rev-parse', 'HEAD'), steps: [] }) });
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; }); child.once('close', () => resolve(out.trim()));
  })));
  const settled = outputs.filter(line => line.includes('"interrupted"'));
  assert.equal(settled.length, 1, outputs.join('\n'));
  assert.ok(outputs.every(line => line === 'null' || line.includes('"interrupted"')), 'the others found it already settled: ' + outputs.join('\n'));
}));

test('a staged rename of a file the update changes blocks', () => fixture(async ({ repo, updater, push }) => {
  await push({ 'apps/ui/page.txt': 'one\nchanged\nthree\n' });
  sh(repo, 'mv', 'apps/ui/page.txt', 'apps/ui/moved.txt');
  const { status } = await updater.check();
  assert.equal(status.blockers[0]?.code, 'local_changes_overlap', JSON.stringify(status));
  assert.ok(status.blockers[0].files.includes('apps/ui/page.txt'));
}));

test('an ignored local file where the update adds one blocks instead of being overwritten', () => fixture(async ({ repo, updater, push }) => {
  await writeFile(join(repo, '.git/info/exclude'), 'secret-notes.txt\n');
  await writeFile(join(repo, 'secret-notes.txt'), 'mine');
  await push({ 'secret-notes.txt': 'from main' });
  const { status } = await updater.check();
  assert.equal(status.blockers[0]?.code, 'untracked_overwritten');
  assert.deepEqual(status.blockers[0].files, ['secret-notes.txt']);
}));

test('reconcile refuses a renamed or deleted protected file, and apply rechecks the commit', () => fixture(async ({ repo, root, updater, push, commit }) => {
  await commit({ 'apps/ui/page.txt': 'one\nmine\nthree\n' });
  await push({ 'apps/ui/page.txt': 'one\ntheirs\nthree\n' });
  const started = await updater.reconcileStart();
  await writeFile(join(started.worktree, 'apps/ui/page.txt'), 'one\nboth\nthree\n');
  sh(started.worktree, 'mv', 'packages/pi-host/run-checks.mjs', 'packages/pi-host/renamed.txt');
  const renamed = await updater.reconcileFinish();
  assert.equal(renamed.ok, false, JSON.stringify(renamed));
  assert.equal(renamed.problems[0].file, 'packages/pi-host/run-checks.mjs');
  sh(started.worktree, 'mv', 'packages/pi-host/renamed.txt', 'packages/pi-host/run-checks.mjs');
  sh(started.worktree, 'rm', '-q', 'packages/pi-host/run-checks.mjs');
  assert.equal((await updater.reconcileFinish()).ok, false, 'a deleted protected file is refused');
  sh(started.worktree, 'checkout', 'HEAD', '--', 'packages/pi-host/run-checks.mjs');
  const finished = await updater.reconcileFinish();
  assert.equal(finished.ok, true, JSON.stringify(finished));
  // A reconcile commit written by hand that drops the gate is refused at install time.
  const bad = sh(started.worktree, 'commit-tree', sh(started.worktree, 'rev-parse', `${finished.commit}^{tree}`), '-p', sh(repo, 'rev-parse', 'HEAD'), '-p', sh(repo, 'rev-parse', 'origin/main'), '-m', 'x');
  sh(started.worktree, 'rm', '-q', 'packages/pi-host/run-checks.mjs');
  const dropped = sh(started.worktree, 'commit-tree', sh(started.worktree, 'write-tree'), '-p', sh(repo, 'rev-parse', 'HEAD'), '-p', sh(repo, 'rev-parse', 'origin/main'), '-m', 'drop gate');
  await writeFile(join(root, 'updates/reconcile.json'), JSON.stringify({ commit: dropped }));
  const refused = await updater.apply();
  assert.equal(refused.outcome, 'failed');
  assert.match(refused.detail, /^merge: The reconciled commit is not safe to install: .*run-checks\.mjs is protected/);
  await writeFile(join(root, 'updates/reconcile.json'), JSON.stringify({ commit: bad }));
  assert.equal((await updater.apply()).outcome, 'updated');
}));

