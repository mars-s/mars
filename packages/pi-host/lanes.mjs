// Lanes: several chats change Mars at once, each in its own git worktree with its own preview,
// and finished work lands on main through one ordered merge queue. Spec: docs/LANES.md.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { guardChanges } from './protected-files.mjs';

const pexec = promisify(execFile);
const HOST = 'packages/pi-host/';
const UI = 'apps/ui/';
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const tail = (text, n = 1500) => (text.length > n ? '...' + text.slice(-n) : text);
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'lane';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, status = 400) => Object.assign(Error(message), { status });

/** Run a program; never throws. */
export async function run(file, args, { cwd, env, timeout = 120000 } = {}) {
  try {
    const { stdout, stderr } = await pexec(file, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const code = typeof error.code === 'number' ? error.code : -1;
    return { code, stdout: error.stdout || '', stderr: (error.stderr || error.message || '') + (error.killed ? '\n(stopped: it ran too long)' : '') };
  }
}

export const lanesEnabled = (env = process.env) => env.MARS_LANES_DISABLED !== '1';

// A lock's owner line: "<pid> <boot id> <process start time> <random>". The boot id and the
// start time tell a dead owner from a live process that reused its pid (after a reboot, or
// any other process); the random part makes each lock its own, so a process only ever removes
// the lock it took, or the exact stale one it saw.
const BOOT_ID = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((s) => s.trim(), () => '');
async function startTime(pid) {
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '';
  } catch { return ''; }
}
const ownLine = async () => [process.pid, BOOT_ID || '-', (await startTime(process.pid)) || '-', randomBytes(6).toString('hex')].join(' ');

/** Whether a lock's owner is gone. Takes the owner line read from the lock (or null if none). */
async function staleOwner(path, line) {
  if (!line) {
    try { return Date.now() - (await stat(path)).mtimeMs > 10000; } catch { return false; }
  }
  const [pidText, boot, started] = line.split(' ');
  const pid = Number(pidText);
  if (!pid) return true;
  if (boot && boot !== '-' && BOOT_ID && boot !== BOOT_ID) return true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
  // The pid runs (or belongs to another user): stale only if it is a different process now.
  if (started && started !== '-') { const now = await startTime(pid); if (now && now !== started) return true; }
  return false;
}
const readOwner = (path) => readFile(join(path, 'owner'), 'utf8').then((s) => s.trim(), () => '');

/**
 * A lock every process on this machine shares (the host and scripts/lane-cli.mjs): a directory
 * made atomically, holding its owner line, removed when the work ends or found stale after a
 * crash. With wait false it gives up at once and returns { held: false }.
 */
export async function withFileLock(path, work, { wait = true, waitMs = 30000 } = {}) {
  const started = Date.now();
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; } catch (error) {
      if (error.code === 'ENOENT') { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); continue; }
      if (error.code !== 'EEXIST') throw error;
      const seen = await readOwner(path);
      if (await staleOwner(path, seen)) {
        // Move it aside first (atomic, so only one process wins it), then make sure what was
        // moved is the stale lock seen, not a fresh one another process took meanwhile.
        const aside = path + '.stale-' + randomBytes(6).toString('hex');
        if (await rename(path, aside).then(() => true, () => false)) {
          if ((await readOwner(aside)) === seen) await rm(aside, { recursive: true, force: true });
          else await rename(aside, path).catch(() => rm(aside, { recursive: true, force: true }));
        }
        continue;
      }
      if (!wait) return { held: false };
      if (Date.now() - started > waitMs) throw fail('The lanes are busy in another process; try again in a moment.', 503);
      await sleep(20);
    }
  }
  const mine = await ownLine();
  try {
    await writeFile(join(path, 'owner'), mine, { mode: 0o600 });
    return { held: true, value: await work() };
  } finally {
    // Only this lock: if it was judged stale and taken over meanwhile, the new owner keeps it.
    if ((await readOwner(path)) === mine) await rm(path, { recursive: true, force: true });
  }
}

/** git diff --name-status -z output as rows; -z keeps unusual file names unquoted. */
export function parseNameStatus(text) {
  const parts = text.split('\0');
  const rows = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) rows.push({ status: parts[i], path: parts[i + 1] });
  return rows;
}

export function createLanes({
  repo, root, env = process.env, node = process.execPath,
  dir = env.MARS_LANES_DIR || join(dirname(repo), basename(repo) + '-lanes'),
  main = env.MARS_LANES_MAIN || 'main',
  previewsMax = Number(env.MARS_LANE_PREVIEWS) || 2,
  publicOrigin = env.MARS_PUBLIC_ORIGIN || '',
  // Injected by the check: previews need systemd and tailscale; checks run real programs.
  previews = true, checkTimeoutMs = 300000, retryMs = 60000,
  // The tailnet CLI; this machine wraps a user-space tailscaled in ~/.local/bin.
  tailscale = env.MARS_TAILSCALE || (existsSync(join(env.HOME || '', '.local/bin/tailscale')) ? join(env.HOME, '.local/bin/tailscale') : 'tailscale'),
  // After a merge that changes dependencies the checkout installs them, so the live interface
  // (which runs from the checkout) finds them. Injected by the check.
  installDependencies = (cwd) => (process.platform === 'linux' && previews
    ? run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=2500M', 'npm', 'install', '--no-audit', '--no-fund'], { cwd, timeout: 900000 })
    : run('npm', ['install', '--no-audit', '--no-fund'], { cwd, timeout: 900000 })),
}) {
  const file = join(root, 'data/lanes.json');
  // State changes take stateLock (short); the merge queue runs under queueLock, held by one
  // process at a time for as long as it merges.
  const stateLock = join(root, 'data/lanes.lock'), queueLock = join(root, 'data/lanes-queue.lock');
  let lock = Promise.resolve(), queueRun = Promise.resolve(), recovery = null, recovering = false;
  const git = (cwd, args, timeout) => run('git', args, { cwd, timeout });

  // The file is the only state: every change re-reads it, edits it and writes it back in one
  // short step under a lock all processes share, so long merges and previews never write a
  // stale copy and a second process (scripts/lane-cli.mjs) never loses or undoes a change.
  async function read() {
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); } catch { state = {}; }
    state.lanes ||= {}; state.queue ||= []; state.paused = state.paused === true;
    return state;
  }
  async function write(state) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
  }
  // The first use in a process recovers merges a crash cut short, unless a live runner holds
  // the queue (then that runner is still merging, and recovers nothing of its own).
  async function mutate(change) {
    if (!recovering) {
      recovery ||= (async () => {
        recovering = true;
        try { await withFileLock(queueLock, recover, { wait: false }); } catch { /* the next runner recovers */ } finally { recovering = false; }
      })();
      await recovery;
    }
    return change === undefined ? undefined : mutateNow(change);
  }
  function mutateNow(change) {
    const next = lock.then(() => withFileLock(stateLock, async () => {
      const state = await read();
      const result = await change(state);
      await write(state);
      return result;
    }).then((locked) => locked.value));
    lock = next.catch(() => {});
    return next;
  }
  /**
   * A merge cut short by a crash, found by the next queue runner (only a runner holding
   * queueLock may judge this, so a merge still running in another process is left alone):
   * if main has it, finish what follows (installing dependencies, cleaning up); otherwise it
   * goes first in the queue again.
   */
  async function recover() {
    const stuck = await mutate((state) => Object.values(state.lanes).filter((lane) => lane.state === 'merging').map((lane) => ({ ...lane })));
    for (const lane of stuck) {
      const done = (await git(repo, ['merge-base', '--is-ancestor', lane.branch, main])).code === 0;
      if (!done) {
        await mutate((state) => {
          const l = state.lanes[lane.id];
          if (!l || l.state !== 'merging') return;
          l.state = 'queued';
          if (!state.queue.includes(l.id)) state.queue.unshift(l.id);
        });
        continue;
      }
      let note = 'Merged (found after a restart).';
      if (lane.pendingInstall) {
        const installed = await installDependencies(repo);
        note += installed.code === 0 ? ' Dependencies installed in the checkout.' : ' npm install in the checkout failed: ' + tail(installed.stdout + installed.stderr, 600) + ' Run npm install there.';
      }
      await mutate((state) => {
        state.queue = state.queue.filter((q) => q !== lane.id);
        const l = state.lanes[lane.id];
        if (!l) return;
        delete l.pendingInstall;
        touch(l, { state: 'merged', note, mergedCommit: l.mergedCommit || null });
      });
      await cleanup(lane);
    }
  }
  const load = () => mutate(() => {});
  const find = (state, id) => {
    const found = state.lanes[String(id ?? '')];
    if (!found) throw fail('No lane ' + JSON.stringify(id) + '. lane_list shows them.', 404);
    return found;
  };
  const touch = (l, fields) => Object.assign(l, fields, { updatedAt: new Date().toISOString() });
  const patch = (id, fields) => mutate((state) => { const l = state.lanes[id]; if (l) touch(l, fields); return l ? view(state, l) : null; });
  const view = (state, l) => {
    const at = state.queue.indexOf(l.id);
    return {
      id: l.id, title: l.title, state: l.state, branch: l.branch, worktree: l.worktree,
      // Pi conversation ids can be numbers; tools promise strings.
      conversationId: l.conversationId == null || l.conversationId === '' ? null : String(l.conversationId),
      queuePosition: at < 0 ? null : at + 1,
      preview: l.preview ? { url: l.preview.url, state: l.preview.state || 'running' } : null,
      note: l.note || '', changed: l.changed || [], mergedCommit: l.mergedCommit || null, updatedAt: l.updatedAt || '',
    };
  };
  const listOf = (state) => {
    const at = (id) => { const i = state.queue.indexOf(id); return i < 0 ? 1e9 : i; };
    const lanes = Object.values(state.lanes).filter((l) => l.state !== 'closed')
      .sort((a, b) => at(a.id) - at(b.id) || String(a.createdAt).localeCompare(String(b.createdAt)));
    return { lanes: lanes.map((l) => view(state, l)), queue: [...state.queue], paused: state.paused, main, previewsMax };
  };
  const list = () => mutate(listOf);
  const snapshot = (id) => mutate((state) => ({ ...find(state, id) }));

  async function start({ title }, conversationId) {
    const name = String(title || '').trim();
    if (!name) throw fail('Give the lane a short title, e.g. "Resizable sidebar".');
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', main])).code !== 0) throw fail('The checkout has no ' + main + ' branch.');
    const id = slug(name) + '-' + randomBytes(2).toString('hex');
    const branch = 'lane/' + id, worktree = join(dir, id);
    await mkdir(dir, { recursive: true });
    const added = await git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, main]);
    if (added.code !== 0) throw fail('git worktree add failed: ' + tail(added.stderr, 400), 500);
    // Dependencies come from the checkout, so nothing is installed: hard links (a second and no
    // extra disk), because Turbopack refuses a node_modules symlink that leaves the project.
    if (existsSync(join(repo, 'node_modules')) && !existsSync(join(worktree, 'node_modules'))) {
      const linked = await run('cp', ['-al', join(repo, 'node_modules'), join(worktree, 'node_modules')], { timeout: 120000 });
      if (linked.code !== 0) {
        await rm(join(worktree, 'node_modules'), { recursive: true, force: true });
        await symlink(join(repo, 'node_modules'), join(worktree, 'node_modules'));
      }
    }
    const base = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    const now = new Date().toISOString();
    const record = { id, title: name, branch, worktree, base, state: 'open',
      conversationId: conversationId == null || conversationId === '' ? null : String(conversationId), createdAt: now, updatedAt: now };
    const shown = await mutate((state) => { state.lanes[id] = record; return view(state, record); });
    return { ...shown, next: 'Edit files only inside ' + worktree + ' (absolute paths, or host_exec with cwd set to it). lane_preview { id: "' + id + '" } runs this lane\'s own Mars for the owner to try; lane_submit { id: "' + id + '", message } queues it to merge into ' + main + '.' };
  }

  async function changes(worktree, against, cached = false) {
    const out = await git(worktree, ['diff', ...(cached ? ['--cached'] : []), '--name-status', '-z', '--no-renames', against]);
    return parseNameStatus(out.stdout);
  }
  /** The lane's worktree must be on its own branch: that branch is what merges. */
  async function onBranch(l) {
    const head = (await git(l.worktree, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim();
    return head === l.branch ? '' : 'The worktree is on ' + (head || 'a detached HEAD') + ', not ' + l.branch + '; run git switch ' + l.branch + ' in ' + l.worktree + ' (bring any commits along first).';
  }

  async function submit({ id, message }) {
    const l = await snapshot(id);
    if (!['open', 'blocked'].includes(l.state)) throw fail('Lane ' + id + ' is ' + l.state + '; only an open or blocked lane can be submitted.');
    const wt = l.worktree;
    const gitDir = (await git(wt, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (['rebase-merge', 'rebase-apply'].some((name) => existsSync(join(gitDir, name))))
      throw fail('A rebase is still in progress in ' + wt + '. Finish it (git rebase --continue) or abort it first.');
    const wrongBranch = await onBranch(l);
    if (wrongBranch) throw fail(wrongBranch);
    await git(wt, ['add', '-A']);
    const base = (await git(wt, ['merge-base', main, 'HEAD'])).stdout.trim();
    const staged = await changes(wt, base, true);
    const refused = guardChanges(staged);
    if (refused.length) { await git(wt, ['reset', '-q']); throw fail('Refused: ' + refused.map((r) => r.reason).join(' ') + ' Remove those changes and submit again.'); }
    if ((await git(wt, ['diff', '--cached', '--quiet'])).code === 1) {
      const who = (await git(repo, ['config', 'user.email'])).stdout.trim() ? [] : ['-c', 'user.name=Mars', '-c', 'user.email=mars@localhost'];
      const committed = await git(wt, [...who, 'commit', '-q', '-m', String(message || l.title)]);
      if (committed.code !== 0) throw fail('git commit failed: ' + tail(committed.stderr, 400), 500);
    }
    if ((await git(wt, ['rev-list', '--count', main + '..HEAD'])).stdout.trim() === '0') throw fail('Lane ' + id + ' has no changes to merge yet.');
    const paused = await mutate((state) => {
      touch(find(state, id), { state: 'queued', note: '', changed: staged.map((row) => row.path) });
      state.queue = state.queue.filter((q) => q !== id).concat(id);
      return state.paused;
    });
    if (!paused) await processQueue();
    const shown = await mutate((state) => view(state, find(state, id)));
    return { ...shown, next: nextFor(shown, paused) };
  }
  function nextFor(l, paused) {
    if (l.state === 'merged') return 'Merged into ' + main + ' as ' + String(l.mergedCommit).slice(0, 8) + '.' + (l.note ? ' ' + l.note : '') + ' Interface changes are live now. Publish with github_push; host changes also need host_deploy or the updater.';
    if (l.state === 'blocked') return l.note + ' Fix it in ' + l.worktree + ', then lane_submit again.';
    if (l.state === 'queued') return 'Waiting at position ' + l.queuePosition + ' in the merge queue.' + (paused ? ' Merging is paused; the owner resumes it in Settings, Lanes.' : '');
    return '';
  }

  /** Merge queued lanes in order, one at a time. Calls queue behind each other. */
  let retry = null;
  function retryLater() {
    if (retry) return;
    retry = setTimeout(() => { retry = null; void processQueue(); }, retryMs);
    retry.unref?.();
  }
  function processQueue({ force = false } = {}) {
    queueRun = queueRun.then(async () => {
      // Another process may be the runner; it takes this lane in turn. If it is just letting go,
      // try again briefly so a lane queued at that moment is not left waiting.
      for (let attempt = 0; attempt < 50; attempt++) {
        const ran = await withFileLock(queueLock, () => runQueue(force), { wait: false });
        if (ran.held) return;
        const waiting = await mutate((state) => state.queue.length > 0 && (force || !state.paused));
        if (!waiting) return;
        await sleep(100);
      }
      // Still held by another process: try again in a minute, so a lane is not left waiting if
      // that process stops before reaching it.
      retryLater();
    }).catch(() => {});
    return queueRun;
  }
  async function runQueue(force) {
    await recover();
    for (;;) {
        const next = await mutate((state) => {
          while (state.queue.length && !state.lanes[state.queue[0]]) state.queue.shift();
          if ((state.paused && !force) || !state.queue.length) return null;
          const l = state.lanes[state.queue[0]];
          touch(l, { state: 'merging', note: '' });
          return { ...l };
        });
        if (!next) return;
        const result = await mergeOne(next).catch((error) => ({ blocked: 'The merge failed unexpectedly: ' + error.message }));
        await mutate((state) => {
          state.queue = state.queue.filter((q) => q !== next.id);
          const l = state.lanes[next.id];
          if (!l) return;
          if (result.changed) l.changed = result.changed;
          delete l.pendingInstall;
          if (result.blocked) touch(l, { state: 'blocked', note: result.blocked });
          else touch(l, { state: 'merged', mergedCommit: result.commit, note: result.note || '' });
        });
        if (!result.blocked) await cleanup(next);
    }
  }
  async function mergeNow() {
    await processQueue({ force: true });
    return list();
  }

  async function mergeOne(l) {
    const wt = l.worktree;
    if (!existsSync(wt)) return { blocked: 'The worktree ' + wt + ' is gone.' };
    if ((await git(wt, ['status', '--porcelain'])).stdout.trim()) return { blocked: 'The worktree has edits that are not submitted; run lane_submit again to include them.' };
    const wrongBranch = await onBranch(l);
    if (wrongBranch) return { blocked: wrongBranch };
    const rebased = await git(wt, ['rebase', '-q', main]);
    if (rebased.code !== 0) {
      const conflicts = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
      await git(wt, ['rebase', '--abort']);
      return { blocked: 'It conflicts with ' + main + (conflicts.length ? ' in ' + conflicts.join(', ') : '') + '. In the worktree run git rebase ' + main + ' and resolve them.' };
    }
    const rows = await changes(wt, main);
    const changed = rows.map((row) => row.path);
    const refused = guardChanges(rows);
    if (refused.length) return { changed, blocked: 'Refused: ' + refused.map((r) => r.reason).join(' ') };
    const checked = await runChecks(wt, rows);
    if (checked.failed) return { changed, blocked: 'Check failed: ' + checked.failed };
    const branch = (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (branch !== main) return { changed, blocked: 'The checkout is on ' + (branch || 'a detached HEAD') + ', not ' + main + '; the owner must switch it back first.' };
    // Recorded before main moves, so a crash before the install still installs (recover).
    const dependencies = changed.some((path) => /(^|\/)package(-lock)?\.json$/.test(path));
    if (dependencies) await patch(l.id, { pendingInstall: true });
    const merged = await git(repo, ['merge', '-q', '--ff-only', l.branch]);
    if (merged.code !== 0) return { changed, blocked: 'git could not fast-forward ' + main + ': ' + tail(merged.stderr.trim(), 500) + ' An uncommitted edit in the checkout may touch the same file.' };
    let note = '';
    if (dependencies) {
      const installed = await installDependencies(repo);
      note = installed.code === 0 ? 'Dependencies installed in the checkout.' : 'Merged, but npm install in the checkout failed: ' + tail(installed.stdout + installed.stderr, 600) + ' Run npm install there.';
    }
    return { changed, note, commit: (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim() };
  }

  /** The cheap gate: syntax, interface types and lint, and the host checks the change reaches. */
  async function runChecks(wt, rows) {
    const live = rows.filter((row) => row.status !== 'D').map((row) => row.path);
    const ran = [];
    for (const path of live) {
      if (/\.(mjs|cjs|js)$/.test(path) && !path.startsWith(UI + 'public/') ) {
        const syntax = await run(node, ['--check', join(wt, path)]);
        if (syntax.code !== 0) return { ran, failed: 'node --check ' + path + ': ' + tail(syntax.stderr, 800) };
      }
      if (path.endsWith('.json')) {
        try { JSON.parse(await readFile(join(wt, path), 'utf8')); } catch (error) { return { ran, failed: path + ' is not valid JSON: ' + error.message }; }
      }
    }
    ran.push('syntax');
    const ui = live.filter((path) => path.startsWith(UI));
    // A deleted module can break what imports it, so deletions count for the type check.
    if (rows.some((row) => row.path.startsWith(UI) && /\.(tsx?|mts)$/.test(row.path))) {
      const types = await limited(['node_modules/typescript/bin/tsc', '--noEmit', '-p', UI], wt);
      if (types.code !== 0) return { ran, failed: 'interface type check: ' + tail(types.stdout + types.stderr) };
      ran.push('ui types');
    }
    const lintable = ui.filter((path) => /^apps\/ui\/(app|components|lib)\/.*\.(tsx?|mjs|js)$/.test(path)).map((path) => path.slice(UI.length));
    if (lintable.length) {
      const lint = await limited([join(wt, 'node_modules/eslint/bin/eslint.js'), ...lintable], join(wt, UI));
      if (lint.code !== 0) return { ran, failed: 'lint: ' + tail(lint.stdout + lint.stderr) };
      ran.push('ui lint');
    }
    const host = rows.filter((row) => row.path.startsWith(HOST)).map((row) => row.path.slice(HOST.length));
    if (host.length) {
      const checks = await reachingChecks(join(wt, HOST), new Set(host));
      for (const check of checks) {
        // Each check gets its own TMPDIR inside its temporary root, removed after: checks that
        // leave temporary folders behind no longer fill /tmp, which is memory on this machine.
        const temp = await mkdtemp(join(tmpdir(), 'mars-lane-check-'));
        await mkdir(join(temp, 'tmp'), { recursive: true });
        const result = await run(node, [check], { cwd: join(wt, HOST), timeout: checkTimeoutMs,
          env: { ...env, TMPDIR: join(temp, 'tmp'), MARS_PI_ROOT: temp, MARS_REPO_ROOT: wt, MARS_UI_DIR: join(wt, UI), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '', MARS_LANES_DISABLED: '1' } });
        await rm(temp, { recursive: true, force: true });
        if (result.code !== 0) return { ran, failed: check + ': ' + tail(result.stdout + result.stderr) };
        ran.push(check);
      }
    }
    return { ran };
  }
  /** A memory-limited command where systemd allows it, so a type check cannot starve the host. */
  function limited(args, cwd) {
    const scoped = previews && process.platform === 'linux';
    return scoped
      ? run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=2500M', node, ...args], { cwd, timeout: 600000 })
      : run(node, args, { cwd, timeout: 600000 });
  }

  /** Each check-*.mjs that is changed itself or imports, directly or not, a changed host file. */
  async function reachingChecks(hostDir, changed) {
    const graph = new Map();
    async function walk(sub) {
      for (const entry of await readdir(join(hostDir, sub), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = sub ? sub + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await walk(rel);
        else if (/\.(mjs|js|cjs)$/.test(entry.name)) {
          const text = await readFile(join(hostDir, rel), 'utf8');
          graph.set(rel, [...text.matchAll(IMPORT)].map((m) => normalize(join(dirname(rel), m[1])).replace(/\\/g, '/')));
        }
      }
    }
    await walk('');
    const reaches = (start) => {
      const seen = new Set([start]), stack = [start];
      while (stack.length) for (const next of graph.get(stack.pop()) || []) if (!seen.has(next)) { if (changed.has(next)) return true; seen.add(next); stack.push(next); }
      return false;
    };
    return [...graph.keys()].filter((rel) => /^check-[^/]+\.mjs$/.test(rel) && (changed.has(rel) || reaches(rel))).sort();
  }

  async function cleanup(l) {
    await stopPreview(l).catch(() => {});
    await git(repo, ['worktree', 'remove', '--force', l.worktree]);
    await git(repo, ['branch', '-q', '-d', l.branch]);
    await rm(join(root, 'lanes', l.id), { recursive: true, force: true });
  }

  async function close({ id }) {
    const l = await snapshot(id);
    if (l.state === 'merging') throw fail('Lane ' + id + ' is merging now; close it after.');
    await mutate((state) => { state.queue = state.queue.filter((q) => q !== l.id); });
    await stopPreview(l).catch(() => {});
    if (existsSync(l.worktree)) await git(repo, ['worktree', 'remove', '--force', l.worktree]);
    await rm(join(root, 'lanes', l.id), { recursive: true, force: true });
    // An unmerged branch is kept, so closing never loses committed work.
    const deleted = (await git(repo, ['rev-parse', '--verify', '--quiet', l.branch])).code !== 0 || (await git(repo, ['branch', '-q', '-d', l.branch])).code === 0;
    const note = deleted ? '' : 'Branch ' + l.branch + ' kept: it has commits not on ' + main + '.';
    const shown = await patch(l.id, { state: 'closed', note });
    return { ...shown, next: deleted ? 'Closed.' : note };
  }

  // Previews: the lane's own host (fresh data root) and interface, as transient user services.
  const units = (l) => ({ host: 'mars-lane-' + l.id + '-host.service', ui: 'mars-lane-' + l.id + '-ui.service' });
  const systemctl = (args) => run('systemctl', ['--user', ...args], { timeout: 20000 });
  async function stopPreview(l) {
    if (!l.preview) return;
    const { host, ui } = units(l);
    await systemctl(['stop', host, ui]);
    if (l.preview.httpsPort && l.preview.published) await run(tailscale, ['serve', '--https=' + l.preview.httpsPort, 'off'], { timeout: 20000 });
    await mutate((state) => { if (state.lanes[l.id]) delete state.lanes[l.id].preview; });
    delete l.preview;
  }
  async function preview({ id, stop = false }) {
    const l = await snapshot(id);
    if (stop) { await stopPreview(l); return { ...(await patch(id, {})), next: 'Preview stopped.' }; }
    if (!['open', 'blocked', 'queued'].includes(l.state)) throw fail('Lane ' + id + ' is ' + l.state + '; there is nothing to preview.');
    if (!previews) throw fail('Previews are off on this host.');
    // A start already under way (a double click, two chats): leave it be rather than stopping it.
    if (l.preview?.state === 'starting' && Date.now() - (l.preview.at || 0) < 180000)
      return { ...(await patch(id, {})), next: 'Already starting. Open ' + l.preview.url + ' in a minute.' };
    if (l.preview) {
      const active = (await systemctl(['is-active', units(l).host])).stdout.trim() === 'active';
      if (active) return { ...(await patch(id, {})), next: 'Already running. Open ' + l.preview.url + '. Interface edits in the worktree reload by themselves; host edits need lane_preview with stop: true, then again.' };
      await stopPreview(l);
    }
    // Claim a slot first, so two previews started together never share ports.
    let origin = '';
    const slot = await mutate((state) => {
      const running = Object.values(state.lanes).filter((other) => other.preview);
      if (running.length >= previewsMax) throw fail('Already ' + running.length + ' previews running (' + running.map((r) => r.id).join(', ') + '), the most at once. Stop one with lane_preview { id, stop: true }.');
      const used = new Set(running.map((r) => r.preview.index));
      let index = 1; while (used.has(index)) index++;
      const hostPort = 3400 + index * 10, uiPort = hostPort + 1, httpsPort = 8600 + index;
      try { if (publicOrigin) origin = 'https://' + new URL(publicOrigin).hostname + ':' + httpsPort; } catch { /* no public name */ }
      const claimed = { index, hostPort, uiPort, httpsPort, url: 'http://127.0.0.1:' + hostPort + '/', published: false, state: 'starting', token: randomBytes(6).toString('hex'), at: Date.now() };
      touch(find(state, id), { preview: claimed });
      return claimed;
    });
    const { hostPort, uiPort, httpsPort } = slot;
    l.preview = slot;
    // A stop while this start is under way removes the record: each step checks it is still ours
    // and, if not, undoes only what this start made.
    const ours = async () => (await mutate((state) => state.lanes[id]?.preview?.token)) === slot.token;
    const abandon = async () => {
      const { host, ui } = units(l);
      await systemctl(['stop', host, ui]);
      if (l.preview.published) await run(tailscale, ['serve', '--https=' + httpsPort, 'off'], { timeout: 20000 });
      throw fail('The preview was stopped while it was starting.', 409);
    };
    try {
      const data = join(root, 'lanes', l.id);
      await mkdir(join(data, 'data'), { recursive: true, mode: 0o700 });
      // The owner token, so the owner's browser cookie signs in; nothing else is copied.
      const token = join(data, 'data/web-token');
      await copyFile(join(root, 'data/web-token'), token).catch(() => {});
      await chmod(token, 0o600).catch(() => {});
      const { host, ui } = units(l);
      const common = ['--user', '--quiet', '--collect', '-p', 'Restart=no', '--working-directory=' + l.worktree];
      const setenv = (pairs) => Object.entries(pairs).map(([k, v]) => '--setenv=' + k + '=' + v);
      const vars = { MARS_PI_ROOT: data, MARS_REPO_ROOT: l.worktree, MARS_UI_DIR: join(l.worktree, UI), MARS_PI_PORT: hostPort, MARS_UI_PORT: uiPort,
        MARS_PUBLIC_ORIGIN: origin, MARS_ALLOWED_ORIGINS: '', MARS_LANES_DISABLED: '1', MARS_HOST_SERVICE: host, MARS_UI_SERVICE: ui, PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || '' };
      const h = await run('systemd-run', [...common, '--unit=' + host, '-p', 'MemoryMax=900M', ...setenv(vars), node, join(l.worktree, HOST + 'server.mjs')]);
      if (h.code !== 0) throw fail('Could not start the preview host: ' + tail(h.stderr, 400), 500);
      if (!(await ours())) await abandon();
      // The same development server as the live interface (scripts/next.mjs, Turbopack).
      const u = await run('systemd-run', [...common, '--unit=' + ui, '-p', 'MemoryMax=2000M', '--working-directory=' + join(l.worktree, UI),
        ...setenv({ ...vars, MARS_PI_ORIGIN: 'http://127.0.0.1:' + hostPort }),
        node, join(l.worktree, UI + 'scripts/next.mjs'), 'dev']);
      if (u.code !== 0) throw fail('Could not start the preview interface: ' + tail(u.stderr, 400), 500);
      if (!(await ours())) await abandon();
      let published = false;
      if (origin) published = (await run(tailscale, ['serve', '--bg', '--https=' + httpsPort, 'http://127.0.0.1:' + hostPort], { timeout: 20000 })).code === 0;
      const url = published ? origin + '/' : 'http://127.0.0.1:' + hostPort + '/';
      Object.assign(l.preview, { url, published });
      const kept = await mutate((state) => {
        const live = state.lanes[id];
        if (live?.preview?.token !== slot.token) return false;
        touch(live, { preview: { ...l.preview } });
        return true;
      });
      if (!kept) await abandon();
    } catch (error) {
      if (error.status !== 409 && (await ours().catch(() => false))) await stopPreview(l).catch(() => {});
      throw error;
    }
    // Wait for the first interface page (it compiles on the first visit).
    let ready = false;
    const deadline = Date.now() + 150000;
    while (!ready && Date.now() < deadline) {
      if (!(await ours())) return { ...(await patch(id, {})), next: 'The preview was stopped while it was starting.' };
      try { ready = (await fetch('http://127.0.0.1:' + uiPort + '/', { signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) })).status < 500; } catch { /* starting */ }
      if (!ready) await sleep(1000);
    }
    const shown = await mutate((state) => {
      const live = state.lanes[id];
      if (live?.preview) live.preview.state = ready ? 'running' : 'starting';
      return live ? view(state, live) : null;
    });
    const url = l.preview.url;
    return { ...shown, next: (ready ? 'Ready: ' : 'Still starting (the first page compiles for a minute or two): ') + url +
      ' runs this lane with an empty data root (no chats or sign-ins). Interface edits in the worktree reload by themselves; after host edits run lane_preview { id, stop: true } then lane_preview again.' + (l.preview.published ? '' : ' It is reachable on this machine only.') };
  }

  function order({ ids }) {
    if (!Array.isArray(ids)) throw fail('ids must be the queued lane ids in the new order.');
    return mutate((state) => {
      const wanted = ids.map(String).filter((id) => state.queue.includes(id) && state.lanes[id]?.state === 'queued');
      const merging = state.queue.filter((id) => state.lanes[id]?.state === 'merging');
      state.queue = [...merging, ...wanted, ...state.queue.filter((id) => !merging.includes(id) && !wanted.includes(id))];
      return listOf(state);
    });
  }
  async function pause({ paused }) {
    const shown = await mutate((state) => { state.paused = paused === true; return listOf(state); });
    if (!shown.paused) void processQueue();
    return shown;
  }

  async function route(method, pathname, body = {}) {
    const parts = pathname.split('/').filter(Boolean).slice(2); // after api/lanes
    if (method === 'GET' && !parts.length) return list();
    if (method !== 'POST') return undefined;
    if (parts[0] === 'order') return order(body);
    if (parts[0] === 'pause') return pause(body);
    if (parts[0] === 'merge') return mergeNow();
    if (parts[1] === 'preview') return preview({ id: parts[0], stop: body.on === false });
    if (parts[1] === 'close') return close({ id: parts[0] });
    return undefined;
  }

  return { list, start, submit, preview, close, order, pause, mergeNow, route, processQueue, load };
}

const LaneView = Type.Object({
  id: Type.String({ description: 'Lane id, e.g. "resizable-sidebar-3f2a".' }),
  title: Type.String({ description: 'Short title given at lane_start.' }),
  state: Type.String({ description: 'open, queued, merging, blocked (see note), merged or closed.' }),
  branch: Type.String({ description: 'Git branch, "lane/<id>".' }),
  worktree: Type.String({ description: 'Absolute path of the lane\'s own checkout. Edit only here.' }),
  conversationId: Type.Union([Type.String(), Type.Null()], { description: 'The chat that started the lane, or null.' }),
  queuePosition: Type.Union([Type.Integer(), Type.Null()], { description: 'Place in the merge queue from 1, or null when not queued.' }),
  preview: Type.Union([Type.Object({
    url: Type.String({ description: 'Link the owner opens to try this lane.' }),
    state: Type.String({ description: '"starting" or "running".' }),
  }), Type.Null()], { description: 'The running preview, or null.' }),
  note: Type.String({ description: 'Why the lane is blocked, or another short note; empty when none.' }),
  changed: Type.Array(Type.String({ description: 'A repository-relative path.' }), { description: 'Files the lane changes against main.' }),
  mergedCommit: Type.Union([Type.String(), Type.Null()], { description: 'The main commit after merging, or null.' }),
  updatedAt: Type.String({ description: 'ISO time of the last change.' }),
});
const WithNext = Type.Object({ ...LaneView.properties, next: Type.String({ description: 'What to do next, in plain words.' }) });

export function createLanesExtension(lanes) {
  const tool = (name, description, parameters, result, execute, replay = 'unsafe') => defineTool({
    name, description, parameters: Type.Object(parameters), replay, deferred: true, executionMode: 'sequential',
    outputLimits: { maxBytes: 16000, maxLines: 300 }, structuredOutputSchema: result,
    execute: async (args, api) => {
      const value = await execute(args, api);
      return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  const Id = Type.String({ description: 'Lane id from lane_start or lane_list.' });
  return defineExtension({ name: 'mars-lanes', tools: [
    tool('lane_start', 'Start a lane: your own git worktree and branch of Mars, so several chats can change Mars at once without clashing.\nUse it before editing the Mars checkout whenever another chat may be working on Mars too. Edit only inside the returned worktree; the live checkout and other lanes stay untouched. Then lane_preview to try it and lane_submit to merge it in order.\nExample: await tools.lane_start({ title: "Resizable sidebar" })',
      { title: Type.String({ description: 'Short title of the change, e.g. "Resizable sidebar".', minLength: 1, maxLength: 80 }) }, WithNext,
      (args, api) => lanes.start(args, api?.conversationId)),
    tool('lane_preview', 'Run a lane\'s own Mars (its host and interface, with an empty data root) at a private link the owner can open.\nUse it to try a lane before merging. Interface edits reload by themselves; after host edits, stop it and start it again. At most two previews run at once; stop: true stops one.\nExample: await tools.lane_preview({ id: "resizable-sidebar-3f2a" })',
      { id: Id, stop: Type.Optional(Type.Boolean({ description: 'true stops the preview. Default false.' })) }, WithNext, (args) => lanes.preview(args)),
    tool('lane_submit', 'Commit a lane\'s changes and queue it to merge into main; lanes merge one at a time in the order submitted.\nUse it when the lane is done and tried. Merging rebases onto main, refuses protected files, runs the checks the change reaches, then fast-forwards main and removes the worktree. Returns merged, queued or blocked with the reason to fix, then submit again.\nExample: await tools.lane_submit({ id: "resizable-sidebar-3f2a", message: "Resizable sidebar, on by default" })',
      { id: Id, message: Type.Optional(Type.String({ description: 'Commit message. Default: the lane title.', maxLength: 400 })) }, WithNext, (args) => lanes.submit(args)),
    tool('lane_list', 'List the lanes, the merge queue order and whether merging is paused.\nUse it to find your lane id, see who else is changing Mars, or check where a lane is in the queue.\nExample: await tools.lane_list({})', {}, Type.Object({
      lanes: Type.Array(LaneView, { description: 'Lanes not closed, queued ones first in queue order.' }),
      queue: Type.Array(Type.String({ description: 'A lane id.' }), { description: 'Lane ids waiting to merge, first merges next.' }),
      paused: Type.Boolean({ description: 'true when the owner paused merging.' }),
      main: Type.String({ description: 'The branch lanes merge into.' }),
      previewsMax: Type.Integer({ description: 'Most previews running at once.' }),
    }), () => lanes.list(), 'safe'),
    tool('lane_close', 'Close a lane: stop its preview and remove its worktree. A branch with unmerged commits is kept, so no work is lost.\nUse it to give up on a lane or tidy one that is merged.\nExample: await tools.lane_close({ id: "resizable-sidebar-3f2a" })',
      { id: Id }, WithNext, (args) => lanes.close(args)),
  ] });
}
