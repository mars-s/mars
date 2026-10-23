// Lanes: several chats change Mars at once, each in its own git worktree with its own preview,
// and finished work lands on main through one ordered merge queue. Spec: docs/LANES.md.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

export function createLanes({
  repo, root, env = process.env, node = process.execPath,
  dir = env.MARS_LANES_DIR || join(dirname(repo), basename(repo) + '-lanes'),
  main = env.MARS_LANES_MAIN || 'main',
  previewsMax = Number(env.MARS_LANE_PREVIEWS) || 2,
  publicOrigin = env.MARS_PUBLIC_ORIGIN || '',
  // Injected by the check: previews need systemd and tailscale; checks run real programs.
  previews = true, checkTimeoutMs = 300000,
  // The tailnet CLI; this machine wraps a user-space tailscaled in ~/.local/bin.
  tailscale = env.MARS_TAILSCALE || (existsSync(join(env.HOME || '', '.local/bin/tailscale')) ? join(env.HOME, '.local/bin/tailscale') : 'tailscale'),
}) {
  const file = join(root, 'data/lanes.json');
  let state, loading, queueRun = Promise.resolve();
  const git = (cwd, args, timeout) => run('git', args, { cwd, timeout });

  async function load() {
    if (state) return state;
    loading ||= (async () => {
      try { state = JSON.parse(await readFile(file, 'utf8')); } catch { state = {}; }
      state.lanes ||= {}; state.queue ||= []; state.paused = state.paused === true;
      // A merge cut short by a restart: merged if main has it, otherwise first in the queue again.
      for (const lane of Object.values(state.lanes)) if (lane.state === 'merging') {
        const done = (await git(repo, ['merge-base', '--is-ancestor', lane.branch, main])).code === 0;
        if (done) Object.assign(lane, { state: 'merged', note: 'Merged (found after a restart).' });
        else { lane.state = 'queued'; if (!state.queue.includes(lane.id)) state.queue.unshift(lane.id); }
      }
      return state;
    })();
    return loading;
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  async function lane(id) {
    await load();
    const found = state.lanes[String(id ?? '')];
    if (!found) throw fail('No lane ' + JSON.stringify(id) + '. lane_list shows them.', 404);
    return found;
  }
  const position = (id) => { const at = state.queue.indexOf(id); return at < 0 ? null : at + 1; };
  const view = (l) => ({
    id: l.id, title: l.title, state: l.state, branch: l.branch, worktree: l.worktree,
    conversationId: l.conversationId || null, queuePosition: position(l.id),
    preview: l.preview ? { url: l.preview.url, state: l.preview.state || 'running' } : null,
    note: l.note || '', changed: l.changed || [], mergedCommit: l.mergedCommit || null, updatedAt: l.updatedAt || '',
  });
  const touch = (l, fields) => Object.assign(l, fields, { updatedAt: new Date().toISOString() });

  async function list() {
    await load();
    const lanes = Object.values(state.lanes).filter((l) => l.state !== 'closed')
      .sort((a, b) => (position(a.id) ?? 1e9) - (position(b.id) ?? 1e9) || String(a.createdAt).localeCompare(String(b.createdAt)));
    return { lanes: lanes.map(view), queue: [...state.queue], paused: state.paused, main, previewsMax };
  }

  async function start({ title }, conversationId) {
    await load();
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
    state.lanes[id] = { id, title: name, branch, worktree, base, state: 'open', conversationId: conversationId || null, createdAt: now, updatedAt: now };
    await save();
    return { ...view(state.lanes[id]), next: 'Edit files only inside ' + worktree + ' (absolute paths, or host_exec with cwd set to it). lane_preview { id: "' + id + '" } runs this lane\'s own Mars for the owner to try; lane_submit { id: "' + id + '", message } queues it to merge into ' + main + '.' };
  }

  async function changes(worktree, against) {
    const out = await git(worktree, ['diff', '--name-status', '--no-renames', against]);
    return out.stdout.split('\n').filter(Boolean).map((line) => { const [status, ...rest] = line.split('\t'); return { status, path: rest.join('\t') }; });
  }

  async function submit({ id, message }) {
    const l = await lane(id);
    if (!['open', 'blocked'].includes(l.state)) throw fail('Lane ' + id + ' is ' + l.state + '; only an open or blocked lane can be submitted.');
    const wt = l.worktree;
    const gitDir = (await git(wt, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (['rebase-merge', 'rebase-apply'].some((name) => existsSync(join(gitDir, name))))
      throw fail('A rebase is still in progress in ' + wt + '. Finish it (git rebase --continue) or abort it first.');
    await git(wt, ['add', '-A']);
    const base = (await git(wt, ['merge-base', main, 'HEAD'])).stdout.trim();
    const staged = (await git(wt, ['diff', '--cached', '--name-status', '--no-renames', base])).stdout.split('\n').filter(Boolean)
      .map((line) => { const [status, ...rest] = line.split('\t'); return { status, path: rest.join('\t') }; });
    const refused = guardChanges(staged);
    if (refused.length) { await git(wt, ['reset', '-q']); throw fail('Refused: ' + refused.map((r) => r.reason).join(' ') + ' Remove those changes and submit again.'); }
    if ((await git(wt, ['diff', '--cached', '--quiet'])).code === 1) {
      const who = (await git(repo, ['config', 'user.email'])).stdout.trim() ? [] : ['-c', 'user.name=Mars', '-c', 'user.email=mars@localhost'];
      const committed = await git(wt, [...who, 'commit', '-q', '-m', String(message || l.title)]);
      if (committed.code !== 0) throw fail('git commit failed: ' + tail(committed.stderr, 400), 500);
    }
    if ((await git(wt, ['rev-list', '--count', main + '..HEAD'])).stdout.trim() === '0') throw fail('Lane ' + id + ' has no changes to merge yet.');
    touch(l, { state: 'queued', note: '', changed: staged.map((row) => row.path) });
    state.queue = state.queue.filter((q) => q !== id).concat(id);
    await save();
    if (state.paused) return { ...view(l), next: 'Queued at position ' + position(id) + '. Merging is paused; the owner resumes it in Settings, Lanes.' };
    await processQueue();
    return { ...view(l), next: nextFor(l) };
  }
  function nextFor(l) {
    if (l.state === 'merged') return 'Merged into ' + main + ' as ' + l.mergedCommit.slice(0, 8) + '. Interface changes are live now. Publish with github_push; host changes also need host_deploy or the updater.';
    if (l.state === 'blocked') return l.note + ' Fix it in ' + l.worktree + ', then lane_submit again.';
    if (l.state === 'queued') return 'Waiting at position ' + position(l.id) + ' in the merge queue.';
    return '';
  }

  /** Merge queued lanes in order, one at a time. Calls queue behind each other. */
  function processQueue() {
    queueRun = queueRun.then(async () => {
      await load();
      while (!state.paused && state.queue.length) {
        const l = state.lanes[state.queue[0]];
        if (!l) { state.queue.shift(); continue; }
        touch(l, { state: 'merging', note: '' });
        await save();
        const result = await mergeOne(l).catch((error) => ({ blocked: 'The merge failed unexpectedly: ' + error.message }));
        state.queue = state.queue.filter((q) => q !== l.id);
        if (result.blocked) touch(l, { state: 'blocked', note: result.blocked });
        else touch(l, { state: 'merged', mergedCommit: result.commit, note: '' });
        await save();
        if (!result.blocked) await cleanup(l);
      }
    }).catch(() => {});
    return queueRun;
  }
  async function mergeNow() {
    await load();
    const paused = state.paused;
    state.paused = false;
    await processQueue();
    state.paused = paused;
    await save();
    return list();
  }

  async function mergeOne(l) {
    const wt = l.worktree;
    if (!existsSync(wt)) return { blocked: 'The worktree ' + wt + ' is gone.' };
    if ((await git(wt, ['status', '--porcelain'])).stdout.trim()) return { blocked: 'The worktree has edits that are not submitted; run lane_submit again to include them.' };
    const rebased = await git(wt, ['rebase', '-q', main]);
    if (rebased.code !== 0) {
      const conflicts = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
      await git(wt, ['rebase', '--abort']);
      return { blocked: 'It conflicts with ' + main + (conflicts.length ? ' in ' + conflicts.join(', ') : '') + '. In the worktree run git rebase ' + main + ' and resolve them.' };
    }
    const rows = await changes(wt, main);
    l.changed = rows.map((row) => row.path);
    const refused = guardChanges(rows);
    if (refused.length) return { blocked: 'Refused: ' + refused.map((r) => r.reason).join(' ') };
    const checked = await runChecks(wt, rows);
    l.checks = checked.ran;
    if (checked.failed) return { blocked: 'Check failed: ' + checked.failed };
    const branch = (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (branch !== main) return { blocked: 'The checkout is on ' + (branch || 'a detached HEAD') + ', not ' + main + '; the owner must switch it back first.' };
    const merged = await git(repo, ['merge', '-q', '--ff-only', l.branch]);
    if (merged.code !== 0) return { blocked: 'git could not fast-forward ' + main + ': ' + tail(merged.stderr.trim(), 500) + ' An uncommitted edit in the checkout may touch the same file.' };
    return { commit: (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim() };
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
    if (ui.some((path) => /\.(tsx?|mts)$/.test(path))) {
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
        const temp = await mkdtemp(join(tmpdir(), 'mars-lane-check-'));
        const result = await run(node, [check], { cwd: join(wt, HOST), timeout: checkTimeoutMs,
          env: { ...env, MARS_PI_ROOT: temp, MARS_REPO_ROOT: wt, MARS_UI_DIR: join(wt, UI), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '', MARS_LANES_DISABLED: '1' } });
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
    const l = await lane(id);
    if (l.state === 'merging') throw fail('Lane ' + id + ' is merging now; close it after.');
    state.queue = state.queue.filter((q) => q !== l.id);
    await stopPreview(l).catch(() => {});
    if (existsSync(l.worktree)) await git(repo, ['worktree', 'remove', '--force', l.worktree]);
    await rm(join(root, 'lanes', l.id), { recursive: true, force: true });
    // An unmerged branch is kept, so closing never loses committed work.
    const deleted = (await git(repo, ['branch', '-q', '-d', l.branch])).code === 0;
    touch(l, { state: l.state === 'merged' ? 'merged' : 'closed', note: deleted ? '' : 'Branch ' + l.branch + ' kept: it has commits not on ' + main + '.' });
    await save();
    return { ...view(l), next: deleted ? 'Closed.' : l.note };
  }

  // Previews: the lane's own host (fresh data root) and interface, as transient user services.
  const units = (l) => ({ host: 'mars-lane-' + l.id + '-host.service', ui: 'mars-lane-' + l.id + '-ui.service' });
  const systemctl = (args) => run('systemctl', ['--user', ...args], { timeout: 20000 });
  async function stopPreview(l) {
    if (!l.preview) return;
    const { host, ui } = units(l);
    await systemctl(['stop', host, ui]);
    if (l.preview.httpsPort && l.preview.published) await run(tailscale, ['serve', '--https=' + l.preview.httpsPort, 'off'], { timeout: 20000 });
    delete l.preview;
  }
  async function preview({ id, stop = false }) {
    const l = await lane(id);
    if (stop) { await stopPreview(l); touch(l, {}); await save(); return { ...view(l), next: 'Preview stopped.' }; }
    if (!['open', 'blocked', 'queued'].includes(l.state)) throw fail('Lane ' + id + ' is ' + l.state + '; there is nothing to preview.');
    if (!previews) throw fail('Previews are off on this host.');
    if (l.preview) {
      const active = (await systemctl(['is-active', units(l).host])).stdout.trim() === 'active';
      if (active) return { ...view(l), next: 'Already running. Open ' + l.preview.url + '. Interface edits in the worktree reload by themselves; host edits need lane_preview with stop: true, then again.' };
      await stopPreview(l);
    }
    const running = Object.values(state.lanes).filter((other) => other.preview);
    if (running.length >= previewsMax) throw fail('Already ' + running.length + ' previews running (' + running.map((r) => r.id).join(', ') + '), the most at once. Stop one with lane_preview { id, stop: true }.');
    const used = new Set(running.map((r) => r.preview.index));
    let index = 1; while (used.has(index)) index++;
    const hostPort = 3400 + index * 10, uiPort = hostPort + 1, httpsPort = 8600 + index;
    let origin = '';
    try { if (publicOrigin) origin = 'https://' + new URL(publicOrigin).hostname + ':' + httpsPort; } catch { /* no public name */ }
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
    // The same development server as the live interface (scripts/next.mjs, Turbopack).
    const u = await run('systemd-run', [...common, '--unit=' + ui, '-p', 'MemoryMax=2000M', '--working-directory=' + join(l.worktree, UI),
      ...setenv({ ...vars, MARS_PI_ORIGIN: 'http://127.0.0.1:' + hostPort }),
      node, join(l.worktree, UI + 'scripts/next.mjs'), 'dev']);
    if (u.code !== 0) { await systemctl(['stop', host]); throw fail('Could not start the preview interface: ' + tail(u.stderr, 400), 500); }
    let published = false;
    if (origin) published = (await run(tailscale, ['serve', '--bg', '--https=' + httpsPort, 'http://127.0.0.1:' + hostPort], { timeout: 20000 })).code === 0;
    const url = published ? origin + '/' : 'http://127.0.0.1:' + hostPort + '/';
    l.preview = { index, hostPort, uiPort, httpsPort, url, published, state: 'starting' };
    touch(l, {}); await save();
    // Wait for the host, then for the first interface page (webpack compiles it on first visit).
    let ready = false;
    const deadline = Date.now() + 150000;
    while (!ready && Date.now() < deadline) {
      try { ready = (await fetch('http://127.0.0.1:' + uiPort + '/', { signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) })).status < 500; } catch { /* starting */ }
      if (!ready) await sleep(1000);
    }
    l.preview.state = ready ? 'running' : 'starting';
    touch(l, {}); await save();
    return { ...view(l), next: (ready ? 'Ready: ' : 'Still starting (the first page compiles for a minute or two): ') + url +
      ' runs this lane with an empty data root (no chats or sign-ins). Interface edits in the worktree reload by themselves; after host edits run lane_preview { id, stop: true } then lane_preview again.' + (published ? '' : ' It is reachable on this machine only.') };
  }

  async function order({ ids }) {
    await load();
    if (!Array.isArray(ids)) throw fail('ids must be the queued lane ids in the new order.');
    const wanted = ids.map(String).filter((id) => state.queue.includes(id) && state.lanes[id]?.state === 'queued');
    const merging = state.queue.filter((id) => state.lanes[id]?.state === 'merging');
    state.queue = [...merging, ...wanted, ...state.queue.filter((id) => !merging.includes(id) && !wanted.includes(id))];
    await save();
    return list();
  }
  async function pause({ paused }) {
    await load();
    state.paused = paused === true;
    await save();
    if (!state.paused) void processQueue();
    return list();
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
