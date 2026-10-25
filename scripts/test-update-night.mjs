// The updater, night fixes (owner-approved edits to protected files): an update killed while
// preparing is recorded and its leftovers removed; a commit that lands while the services stop
// is not a failed rollback; and an update holding the lock counts as running before it has
// written its journal. Uses the same fixture as test-update.mjs (copied: it is not exported).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
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

test('an update killed while preparing is recorded as failed and its leftovers go', () => fixture(async ({ repo, root, updater }) => {
  const id = '20261025T000000Z-prep';
  await mkdir(join(root, 'updates', id, 'tree'), { recursive: true });
  await mkdir(join(repo, 'node_modules.incoming-' + id), { recursive: true });
  await mkdir(join(repo, 'apps/ui/.next-build.incoming-' + id), { recursive: true });
  await writeFile(join(root, 'updates/current.json'), JSON.stringify({ id, phase: 'preparing', from: 'x', target: 'y', steps: [{ name: 'build', status: 'running' }], startedAt: new Date().toISOString() }));
  const result = await updater.recover({ wait: false });
  assert.equal(result?.outcome, 'failed', JSON.stringify(result));
  assert.match(result.detail, /Interrupted while preparing/);
  assert.equal(existsSync(join(repo, 'node_modules.incoming-' + id)), false);
  assert.equal(existsSync(join(repo, 'apps/ui/.next-build.incoming-' + id)), false);
  const view = await updater.read();
  assert.equal(view.running, null, 'no longer shown as updating');
}));

test('a commit that lands while the services stop is not a failed rollback', () => {
  let during = async () => {};
  return fixture(async ({ push, updater, head, commit }) => {
    await push({ 'apps/ui/page.txt': 'one\ntwo\nthree\nfour\n' });
    let made = '';
    during = async () => { during = async () => {}; await commit({ 'notes.txt': 'owner\n' }, 'owner commit while stopping'); made = head(); };
    const result = await updater.apply();
    assert.notEqual(result.outcome, 'rollback_failed', JSON.stringify(result).slice(0, 600));
    assert.ok(made, 'the commit was made during the stop');
    assert.equal(head(), made, 'the owner commit is kept and the checkout left on it');
  }, { ops: { stop: async () => { await during(); } } });
});

test('an update holding the lock counts as running before its journal is written', () => fixture(async ({ root, updater }) => {
  await mkdir(join(root, 'updates'), { recursive: true });
  await writeFile(join(root, 'updates/current.json'), JSON.stringify({ id: 'old', phase: 'done', outcome: 'updated', steps: [] }));
  const boot = Math.round((Date.now() / 1000 - uptime()) / 60);
  await writeFile(join(root, 'updates/.lock'), JSON.stringify({ pid: process.pid, boot, nonce: 'n1', id: '20261025T000001Z-new', at: new Date().toISOString() }));
  const view = await updater.read();
  assert.ok(view.running, 'running while the new update checks and fetches');
  assert.equal(view.running.id, '20261025T000001Z-new');
}));
