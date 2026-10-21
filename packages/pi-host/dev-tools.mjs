import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, readdir, cp, symlink, rm, stat, chmod, copyFile, rename, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ROOT, APP, REPO, UI_DIR, PORT, DEPENDENCIES } from './security.mjs';
import { join, relative, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

const output = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);
const SKIP = new Set(['node_modules']);
const skipEntry = name => SKIP.has(name) || name.startsWith('.backup-') || name.startsWith('node_modules.prev') || name.startsWith('.probe');

/** Run a command without a shell. Never throws for a non-zero exit. */
export function sh(cmd, args, { cwd, env, timeoutMs = 120000, input, signal } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 2e6) stdout = stdout.slice(-1e6); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(error.message) }); });
    child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code: code ?? (sig ? 128 : -1), signal: sig, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function same(a, b) { try { return (await readFile(a)).equals(await readFile(b)); } catch { return false; } }
const sameOrAbsent = async (a, b) => (await same(a, b)) || (!(await exists(a)) && !(await exists(b)));
// Only dependency fields and the lockfile need a fresh install; scripts or metadata do not.
async function dependencyKey(dir) {
  let pkg = {};
  try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); } catch {}
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];
  return JSON.stringify(fields.map(field => pkg[field] ?? null));
}
async function files(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (dir === base && skipEntry(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await files(path, base, out); else out.push(relative(base, path));
  }
  return out;
}

// Deploys in flight in this process, by folder. A deploy owned by this process
// but missing here ended without a final status (for example an aborted call).
const ACTIVE = new Set();
const IN_FLIGHT = new Set(['staging', 'scheduled', 'applying', 'restarting']);
export const DEPLOY_TIMEOUTS = { stagingMs: 45 * 60e3, scheduledGraceMs: 5 * 60e3, applyingMs: 20 * 60e3, noStatusMs: 2 * 60e3 };
/** Start time of a process from /proc, or null where /proc is unavailable. */
export async function procStart(pid) {
  try { const stat = await readFile('/proc/' + pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}
async function processAlive(pid, start) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  if (!start) return true;
  const now = await procStart(pid);
  return now === null || now === String(start);
}
const LIVE_UNTOUCHED = 'The live app was not changed.';
/** Read a deploy's recorded status and decide whether it was interrupted. */
export async function deployState(deploysDir, id, now = Date.now()) {
  const dir = join(deploysDir, id);
  let state = null;
  try { state = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')); } catch {}
  if (!state) {
    const age = now - ((await stat(dir).catch(() => null))?.mtimeMs ?? now);
    if (age < DEPLOY_TIMEOUTS.noStatusMs) return { status: 'staging', detail: 'Starting' };
    return { status: 'interrupted', lastStatus: null, detail: 'This deploy never recorded a status: the host process running it stopped while staging, most likely because the service restarted. ' + LIVE_UNTOUCHED + ' Run host_deploy again.' };
  }
  if (!IN_FLIGHT.has(state.status)) return state;
  const at = Date.parse(state.at) || now, started = Date.parse(state.startedAt) || at;
  const owner = state.pid ? 'process ' + state.pid : 'its process';
  let gone = false, stuck = false;
  if (state.status === 'staging') {
    gone = !state.pid || !(await processAlive(state.pid, state.pidStart)) || (state.pid === process.pid && !ACTIVE.has(dir));
    stuck = now - started > DEPLOY_TIMEOUTS.stagingMs;
  } else if (state.status === 'scheduled') {
    stuck = now > (Date.parse(state.restartAt) || at + 600e3) + DEPLOY_TIMEOUTS.scheduledGraceMs;
  } else {
    gone = state.pid ? !(await processAlive(state.pid, state.pidStart)) : false;
    stuck = now - at > DEPLOY_TIMEOUTS.applyingMs;
  }
  if (!gone && !stuck) return state;
  const why = gone ? owner + ' is no longer running' : 'it has not moved on for too long';
  const detail = state.status === 'staging'
    ? 'Interrupted while staging (' + (state.detail || 'staging') + '): ' + why + ', most likely because the service restarted. ' + LIVE_UNTOUCHED + ' Run host_deploy again.'
    : state.status === 'scheduled'
      ? 'Interrupted: the restart was scheduled for ' + (state.restartAt || 'soon') + ' but the watchdog never started. ' + LIVE_UNTOUCHED + ' Run host_deploy again.'
      : 'Interrupted while ' + state.status + ': the watchdog ' + why + '. The live app may be partly updated; check GET /api/host/version and run host_deploy again.';
  return { ...state, status: 'interrupted', lastStatus: state.status, detail };
}
async function listDeploys(deploysDir) { return (await readdir(deploysDir).catch(() => [])).sort(); }

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** Apply a unified diff relative to cwd, refusing patches that touch nothing. */
export async function applyPatch({ patch, cwd, strip = 1, check = false }) {
  if (!patch.trim()) throw Error('Empty patch');
  cwd = resolve(cwd);
  const top = await sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  const inRepo = top.code === 0;
  const runIn = inRepo ? top.stdout.trim() : cwd;
  const base = ['apply', '-p' + strip, '--recount', '--whitespace=nowarn', ...(inRepo && relative(runIn, cwd) ? ['--directory=' + relative(runIn, cwd)] : [])];
  const stats = await sh('git', [...base, '--numstat', '-'], { cwd: runIn, input: patch });
  if (stats.code !== 0) throw Error('Patch is invalid: ' + tail(stats.stderr, 1500));
  const changed = stats.stdout.trim().split('\n').filter(Boolean).map(line => { const [added, removed, ...path] = line.split('\t'); return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }; });
  if (!changed.length) throw Error('Patch touches no files');
  const probe = await sh('git', [...base, '--check', '-'], { cwd: runIn, input: patch });
  if (probe.code !== 0) throw Error('Patch does not apply: ' + tail(probe.stderr, 1500));
  if (!check) {
    const applied = await sh('git', [...base, '-'], { cwd: runIn, input: patch });
    if (applied.code !== 0) throw Error('Patch failed: ' + tail(applied.stderr, 1500));
  }
  return { applied: !check, checked: true, cwd, files: changed };
}

export function createDevTools({
  root = ROOT, appDir = APP, repo = REPO, subdir = 'packages/pi-host',
  service = process.env.MARS_HOST_SERVICE || process.env.MARS_PI_SERVICE || 'mars-pi-host.service', livePort = PORT, deploysDir = root + '/deploys', keep = 12,
  systemdRun = 'systemd-run', bootTimeoutMs = 45000,
} = {}) {
  async function prune() {
    const ids = (await readdir(deploysDir).catch(() => [])).sort();
    const active = await realpath(join(appDir, 'node_modules')).catch(() => '');
    for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
      if (active.startsWith(join(deploysDir, id) + '/')) continue;
      await rm(join(deploysDir, id), { recursive: true, force: true });
    }
  }

  async function stagingBoot(stageRoot, stageApp, signal) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], { cwd: stageApp, env: { ...process.env, MARS_PI_ROOT: stageRoot, MARS_PI_PORT: String(port), MARS_PI_STAGING: '1', MARS_REPO_ROOT: repo, MARS_UI_DIR: UI_DIR, MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    const exited = new Promise(r => child.once('close', code => r(code)));
    const started = Date.now();
    try {
      const ready = await Promise.race([
        (async () => { while (!/agent ready/.test(log)) { if (Date.now() - started > bootTimeoutMs) return 'timeout'; signal?.throwIfAborted(); await new Promise(r => setTimeout(r, 100)); } return 'ready'; })(),
        exited.then(code => 'exited ' + code),
      ]);
      if (ready !== 'ready') return { ok: false, port, error: 'Staging server ' + ready, log: tail(log, 3000) };
      const token = (await readFile(join(stageRoot, 'data/web-token'), 'utf8')).trim();
      const response = await fetch('http://127.0.0.1:' + port + '/api/state', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
      const body = await response.text();
      let state; try { state = JSON.parse(body); } catch {}
      if (response.status !== 200 || !state) return { ok: false, port, error: 'GET /api/state returned ' + response.status, log: tail(log + '\n' + body, 3000) };
      return { ok: true, port, bootMs: Date.now() - started, conversationId: state.conversationId ?? null };
    } catch (error) {
      return { ok: false, port, error: String(error.message || error), log: tail(log, 3000) };
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
  }

  /** Build the exact post-deploy app from a commit, run checks and boot it in isolation. Never touches the live app. */
  async function stage(args = {}, signal) {
    const ctx = {};
    try {
      const plan = await runStage(args, signal, ctx);
      await writeStatus(plan.dir, 'staged', plan.ok ? 'Staged only; nothing deployed' : 'Staging failed; live app untouched');
      return plan;
    } catch (error) { if (ctx.dir) await writeStatus(ctx.dir, 'staging_failed', String(error.message || error)).catch(() => {}); throw error; }
    finally { if (ctx.dir) ACTIVE.delete(ctx.dir); }
  }

  async function runStage({ ref = 'main', skipChecks = false, skipBoot = false } = {}, signal, ctx = {}) {
    const rev = await sh('git', ['-C', repo, 'rev-parse', '--verify', ref + '^{commit}']);
    if (rev.code !== 0) throw Error('Unknown ref ' + ref + ': ' + rev.stderr.trim());
    const commit = rev.stdout.trim();
    const subject = (await sh('git', ['-C', repo, 'log', '-1', '--format=%s', commit])).stdout.trim();
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1') + '-' + commit.slice(0, 8) + '-' + randomBytes(2).toString('hex');
    const dir = join(deploysDir, id), stageRoot = join(dir, 'stage'), stageApp = join(stageRoot, 'app');
    await mkdir(deploysDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 }); // fails rather than reuse another deploy's backup
    ctx.dir = dir; ACTIVE.add(dir);
    const startedAt = new Date().toISOString();
    const phase = detail => writeStatus(dir, 'staging', detail, { startedAt, pid: process.pid, pidStart: ctx.pidStart, commit, subject });
    ctx.pidStart = await procStart(process.pid);
    await phase('Copying the commit');
    await mkdir(stageApp, { recursive: true, mode: 0o700 });
    await mkdir(join(stageRoot, 'data'), { recursive: true, mode: 0o700 });
    for (const name of ['workspace', 'evidence']) await mkdir(join(stageRoot, name), { recursive: true });
    const depth = subdir.split('/').filter(Boolean).length;
    const archive = await sh('bash', ['-o', 'pipefail', '-c', 'git -C "$1" archive "$2" "$3" | tar -x -C "$4" --strip-components="$5"', '_', repo, commit, subdir, stageApp, String(depth)]);
    if (archive.code !== 0) throw Error('git archive failed: ' + archive.stderr);
    if (!(await exists(join(stageApp, 'server.mjs')))) throw Error(subdir + ' at ' + commit.slice(0, 8) + ' has no server.mjs');

    // The deploy copies without deleting, so live-only files remain; mirror them so staging matches the result.
    const live = (await readdir(appDir).catch(() => [])).filter(name => !skipEntry(name));
    const staged = new Set(await readdir(stageApp));
    const appOnly = live.filter(name => !staged.has(name));
    for (const name of appOnly) await cp(join(appDir, name), join(stageApp, name), { recursive: true, preserveTimestamps: true });

    // Workspace lockfiles live at the repository root. Stage only manifests and
    // install only the host workspace when dependencies change, never the UI tree.
    const depRoot = join(stageRoot, 'dependencies');
    await mkdir(depRoot, { recursive: true });
    const rootManifest = await sh('git', ['-C', repo, 'show', commit + ':package.json']);
    const workspace = rootManifest.code === 0 && !!JSON.parse(rootManifest.stdout).workspaces;
    let depsChanged;
    if (workspace) {
      const lock = await sh('git', ['-C', repo, 'show', commit + ':package-lock.json']);
      if (lock.code !== 0) throw Error('Workspace deploy requires the committed root package-lock.json');
      const lockfile = JSON.parse(lock.stdout);
      await writeFile(join(depRoot, 'package.json'), rootManifest.stdout);
      await writeFile(join(depRoot, 'package-lock.json'), lock.stdout);
      for (const path of Object.keys(lockfile.packages || {})) {
        if (!path || path.includes('node_modules')) continue;
        const manifest = await sh('git', ['-C', repo, 'show', commit + ':' + path + '/package.json']);
        if (manifest.code !== 0) throw Error('Missing workspace manifest: ' + path);
        await mkdir(join(depRoot, path), { recursive: true });
        await writeFile(join(depRoot, path, 'package.json'), manifest.stdout);
      }
      // Root lock equality plus the native manifest is the dependency boundary.
      // A recorded lock hash also makes a staged runtime independent of checkout changes.
      const prior = await readFile(join(appDir, '.workspace-lock.json'), 'utf8').catch(() => '');
      depsChanged = prior !== lock.stdout || (await dependencyKey(stageApp)) !== (await dependencyKey(appDir));
      await writeFile(join(stageApp, '.workspace-lock.json'), lock.stdout);
      if (depsChanged) {
        await phase('Installing dependencies');
        const install = await sh('npm', ['ci', '--workspace', subdir, '--include-workspace-root=false', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: depRoot, timeoutMs: 600000, signal });
        if (install.code !== 0) throw Error('Host workspace npm ci failed in staging: ' + tail(install.stderr, 2000));
        await symlink(join(depRoot, 'node_modules'), join(stageApp, 'node_modules'));
      } else await symlink(await exists(join(appDir, 'node_modules')) ? join(appDir, 'node_modules') : DEPENDENCIES, join(stageApp, 'node_modules'));
    } else {
      // Existing standalone deployment fixtures and imports remain reviewable.
      depsChanged = (await dependencyKey(stageApp)) !== (await dependencyKey(appDir)) || !(await sameOrAbsent(join(stageApp, 'package-lock.json'), join(appDir, 'package-lock.json')));
      if (depsChanged) {
        const install = await sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stageApp, timeoutMs: 600000, signal });
        if (install.code !== 0) throw Error('npm ci failed in staging: ' + tail(install.stderr, 2000));
      } else await symlink(join(appDir, 'node_modules'), join(stageApp, 'node_modules'));
    }

    const changed = [], added = [];
    for (const file of await files(stageApp)) {
      if (!(await exists(join(appDir, file)))) added.push(file);
      else if (!(await same(join(stageApp, file), join(appDir, file)))) changed.push(file);
    }
    let checks = { skipped: true };
    if (!skipChecks) {
      await phase('Running host checks');
      const run = await sh(process.execPath, ['run-checks.mjs', '--json'], { cwd: stageApp, env: { MARS_PI_ROOT: stageRoot, MARS_REPO_ROOT: repo, MARS_UI_DIR: UI_DIR, MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' }, timeoutMs: 600000, signal });
      try { checks = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { checks = { ok: false, error: 'run-checks.mjs produced no summary', log: tail(run.stdout + run.stderr, 3000) }; }
      if (run.code !== 0) checks.ok = false;
    }
    if (!skipBoot) await phase('Test boot');
    const boot = skipBoot ? { skipped: true } : await stagingBoot(stageRoot, stageApp, signal);
    const ok = (checks.skipped || checks.ok === true) && (boot.skipped || boot.ok === true);
    const plan = { id, commit, subject, ref, createdAt: new Date().toISOString(), ok, changed, added, appOnly, depsChanged, checks, boot, dir };
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 1), { mode: 0o600 });
    await writeFile(join(dir, 'added.txt'), added.join('\n') + (added.length ? '\n' : ''));
    await prune();
    return plan;
  }

  async function deploy({ ref = 'main', dryRun = false, skipChecks = false, restartDelaySeconds = 5, force = false } = {}, signal) {
    const ids = await listDeploys(deploysDir);
    let previous;
    for (const id of ids.slice(-5).reverse()) {
      const state = await deployState(deploysDir, id);
      if (IN_FLIGHT.has(state.status)) throw Error('Deploy ' + id + ' is still ' + state.status + ' (' + (state.detail || 'in progress') + '). Wait for it to finish, then check host_deploy_status with id ' + id + '.');
      if (id === ids.at(-1) && state.status === 'interrupted') previous = { id, status: 'interrupted', detail: state.detail };
    }
    const ctx = {};
    try { return await deployStaged({ ref, dryRun, skipChecks, restartDelaySeconds, force, previous }, signal, ctx); }
    catch (error) {
      if (ctx.dir && !ctx.scheduled) await writeStatus(ctx.dir, 'staging_failed', String(error.message || error) + '. Live app untouched.').catch(() => {});
      throw error;
    } finally { if (ctx.dir) ACTIVE.delete(ctx.dir); }
  }

  async function deployStaged({ ref, dryRun, skipChecks, restartDelaySeconds, force, previous }, signal, ctx) {
    const plan = await runStage({ ref, skipChecks }, signal, ctx);
    const summary = { ...(previous ? { previous } : {}), id: plan.id, commit: plan.commit.slice(0, 12), subject: plan.subject, ok: plan.ok, changed: plan.changed, added: plan.added, appOnly: plan.appOnly, depsChanged: plan.depsChanged, checks: plan.checks, boot: plan.boot };
    if (!plan.ok) { await writeStatus(plan.dir, 'staging_failed', 'Live app untouched'); return { ...summary, status: 'staging_failed', note: 'Live app untouched.' }; }
    if (dryRun) { await writeStatus(plan.dir, 'dry_run', 'Staging passed; nothing deployed'); return { ...summary, status: 'dry_run' }; }
    if (!force && !plan.changed.length && !plan.added.length && !plan.depsChanged) { await writeStatus(plan.dir, 'noop', 'Live app already matches'); return { ...summary, status: 'noop' }; }
    await writeStatus(plan.dir, 'staging', 'Backing up the live app', { startedAt: plan.createdAt, pid: process.pid, pidStart: ctx.pidStart, commit: plan.commit, subject: plan.subject });
    const backup = await sh('tar', ['-czf', join(plan.dir, 'backup.tgz'), '-C', appDir, '--exclude=./node_modules', '--exclude=./node_modules.prev*', '--exclude=./.backup-*', '.']);
    if (backup.code !== 0) throw Error('Backup failed: ' + backup.stderr);
    if (plan.depsChanged) await writeFile(join(plan.dir, 'deps-changed'), '');
    await copyFile(join(plan.dir, 'stage/app/deploy-watchdog.sh'), join(plan.dir, 'watchdog.sh'));
    await chmod(join(plan.dir, 'watchdog.sh'), 0o755);
    ctx.scheduled = true;
    await writeStatus(plan.dir, 'scheduled', 'Restart in ' + restartDelaySeconds + 's', { startedAt: plan.createdAt, restartAt: new Date(Date.now() + restartDelaySeconds * 1000).toISOString(), commit: plan.commit, subject: plan.subject });
    const unit = 'mars-pi-deploy-' + plan.id.replace(/[^a-zA-Z0-9]/g, '');
    const run = await sh(systemdRun, ['--user', '--no-block', '--collect', '--unit=' + unit, '--on-active=' + restartDelaySeconds + 's', '--timer-property=AccuracySec=100ms', '--setenv=PATH=' + process.env.PATH, '--setenv=HOME=' + process.env.HOME, '/bin/bash', join(plan.dir, 'watchdog.sh'), plan.dir, appDir, service, String(livePort), root]);
    if (run.code !== 0) { await writeStatus(plan.dir, 'schedule_failed', run.stderr); throw Error('Could not schedule watchdog: ' + run.stderr); }
    return { ...summary, status: 'scheduled', unit, restartInSeconds: restartDelaySeconds, next: 'The host restarts shortly and interrupts running calls. Afterwards call host_deploy_status with id ' + plan.id + '.' };
  }

  async function writeStatus(dir, status, detail, extra = {}) {
    const tmp = join(dir, 'status.json.' + process.pid + '.tmp');
    let startedAt;
    try { startedAt = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).startedAt; } catch {}
    await writeFile(tmp, JSON.stringify({ startedAt, ...extra, status, at: new Date().toISOString(), detail }), { mode: 0o600 });
    await rename(tmp, join(dir, 'status.json'));
  }

  async function status({ id } = {}) {
    const ids = (await readdir(deploysDir).catch(() => [])).sort();
    const pick = id || ids.at(-1);
    if (!pick || !ids.includes(pick)) return { deploys: ids.slice(-5), error: pick ? 'Unknown deploy ' + pick : 'No deploys yet' };
    const dir = join(deploysDir, pick);
    const read = async name => { try { return await readFile(join(dir, name), 'utf8'); } catch { return undefined; } };
    const plan = JSON.parse((await read('plan.json')) || '{}');
    const state = await deployState(deploysDir, pick);
    const log = await read('watchdog.log');
    return { id: pick, commit: plan.commit?.slice(0, 12), subject: plan.subject, ...state, changed: plan.changed, added: plan.added, checks: plan.checks && { ok: plan.checks.ok, passed: plan.checks.passed?.length, failed: plan.checks.failed }, boot: plan.boot, ...(log ? { watchdog: tail(log, 2500) } : {}), recent: ids.slice(-5) };
  }

  const extension = defineExtension({
    name: 'host-dev',
    marsPlugin: { title: 'Self Deploy', version: '1.0.0', description: 'apply_patch for multi-file diffs, and host_deploy: stage a Git commit, run every host check and a staging boot, back up, restart under a watchdog that rolls back automatically.' },
    tools: [
      defineTool({
        name: 'apply_patch',
        description: `Apply a unified diff to files on disk, all or nothing.
Use it for changes across several files or large rewrites, in git diff format. Either every hunk applies or nothing changes. Run with check: true first to test without writing. For one exact replacement in one file, edit is simpler. Not run again after an interruption.
Example: await tools.apply_patch({ cwd: "projects/site", patch: "--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-Old\\n+New\\n", check: true })`,
        parameters: Type.Object({
          patch: Type.String({ minLength: 1, description: 'The unified diff text, as from git diff, with --- a/ and +++ b/ headers.' }),
          cwd: Type.String({ minLength: 1, description: 'Folder the diff paths are relative to, usually the repository root, e.g. "projects/site".' }),
          strip: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 1, description: 'Leading path parts to drop, as patch -p. Default 1 removes the a/ and b/ prefixes.' })),
          check: Type.Optional(Type.Boolean({ default: false, description: 'true only tests that the patch applies; nothing is written.' })),
        }),
        replay: 'unsafe', executionMode: 'sequential',
        structuredOutputSchema: Type.Object({
          applied: Type.Boolean({ description: 'True when the files were changed; false for check: true.' }),
          checked: Type.Boolean({ description: 'True: the patch applies cleanly.' }),
          cwd: Type.String({ description: 'Absolute folder used.' }),
          files: Type.Array(Type.Object({
            path: Type.String({ description: 'File changed.' }),
            added: Type.Integer({ description: 'Lines added.' }),
            removed: Type.Integer({ description: 'Lines removed.' }),
          })),
        }),
        execute: async args => output(await applyPatch(args)),
      }),
      defineTool({
        name: 'host_deploy',
        description: `Deploy a committed change to the running Mars host, with automatic rollback.
Use it after committing a change to ${subdir} in ${repo}; the host does not reload by itself. It stages the commit, runs every host check and a test boot, backs up the live app, then restarts ${service}. A watchdog rolls back automatically if the restarted host is unhealthy. Run with dryRun: true first to check without restarting. The restart interrupts running calls, including this one; afterwards call host_deploy_status with the returned id. It refuses while another deploy is still running, and reports in previous when the last deploy was interrupted.
Example: await tools.host_deploy({ ref: "main", dryRun: true })`,
        parameters: Type.Object({
          ref: Type.Optional(Type.String({ description: 'Git branch, tag or commit to deploy. Default "main".' })),
          dryRun: Type.Optional(Type.Boolean({ default: false, description: 'true runs staging, checks and the test boot, then stops before restarting.' })),
          restartDelaySeconds: Type.Optional(Type.Integer({ minimum: 3, maximum: 600, description: 'Seconds to wait before the restart, 3 to 600, so this reply can finish.' })),
          force: Type.Optional(Type.Boolean({ default: false, description: 'true restarts even when the live app already matches the commit.' })),
        }),
        replay: 'unsafe', executionMode: 'sequential', outputLimits: { maxBytes: 20000, maxLines: 300 },
        structuredOutputSchema: Type.Object({
          id: Type.String({ description: 'Deploy id. Pass it to host_deploy_status.' }),
          status: Type.String({ description: '"scheduled", "dry_run", "noop" or "staging_failed".' }),
          previous: Type.Optional(Type.Object({
            id: Type.String({ description: 'The earlier deploy that was interrupted.' }),
            status: Type.String({ description: 'Always "interrupted".' }),
            detail: Type.String({ description: 'Plain explanation of what was cut off and whether the live app changed.' }),
          }, { description: 'Set when the last deploy before this one was interrupted.' })),
          ok: Type.Boolean({ description: 'True when staging, checks and the test boot passed.' }),
          note: Type.Optional(Type.String({ description: 'Plain explanation, e.g. "Live app untouched."' })),
          next: Type.Optional(Type.String({ description: 'What to do after the restart.' })),
        }, { additionalProperties: true }),
        execute: async (args, _api, context) => output(await deploy(args, context?.abortSignal)),
      }),
      defineTool({
        name: 'host_deploy_status',
        description: `Check how a host_deploy went.
Use it after host_deploy, especially after the restart, to see whether it finished or rolled back. Status is one of staging, scheduled, applying, restarting, deployed, rolled_back, staging_failed or interrupted, with check results, the test boot and the watchdog log. interrupted means the deploy stopped without finishing (its process is gone or it stalled); detail says whether the live app changed, then run host_deploy again. Without id, shows the latest deploy.
Example: await tools.host_deploy_status({ id: "20261021T090000Z" })`,
        parameters: Type.Object({ id: Type.Optional(Type.String({ description: 'Deploy id from host_deploy. Default: the latest deploy.' })) }),
        replay: 'safe',
        structuredOutputSchema: Type.Object({
          id: Type.Optional(Type.String({ description: 'The deploy shown.' })),
          status: Type.Optional(Type.String({ description: 'staging, scheduled, applying, restarting, deployed, rolled_back, staging_failed or interrupted.' })),
          detail: Type.Optional(Type.String({ description: 'Plain explanation of the status, e.g. why it was interrupted.' })),
          error: Type.Optional(Type.String({ description: 'Why there is nothing to show, e.g. "No deploys yet".' })),
          recent: Type.Optional(Type.Array(Type.String(), { description: 'The five latest deploy ids.' })),
        }, { additionalProperties: true }),
        execute: async args => output(await status(args)),
      }),
    ],
  });
  return { extension, stage, deploy, status };
}

/**
 * What the live host is running: the commit the watchdog recorded in deployed.json,
 * how far the checkout's main is ahead of it, and the latest deploy if it went wrong.
 * Git results are cached for cacheMs so GET /api/host/version stays cheap.
 */
export function createHostVersion({ root = ROOT, appDir = APP, repo = REPO, deploysDir = root + '/deploys', cacheMs = 30000 } = {}) {
  let cached = null;
  async function liveCommit() {
    try {
      const recorded = JSON.parse(await readFile(join(appDir, 'deployed.json'), 'utf8'));
      if (recorded.commit) return { commit: recorded.commit, subject: recorded.subject ?? null, deployedAt: recorded.deployedAt ?? null, source: 'deployed.json' };
    } catch {}
    // Older deploys did not write deployed.json: use the newest deploy that finished.
    for (const id of (await listDeploys(deploysDir)).reverse()) {
      try {
        const state = JSON.parse(await readFile(join(deploysDir, id, 'status.json'), 'utf8'));
        if (state.status !== 'deployed') continue;
        const plan = JSON.parse(await readFile(join(deploysDir, id, 'plan.json'), 'utf8'));
        return { commit: plan.commit, subject: plan.subject ?? null, deployedAt: state.at ?? null, source: 'deploys/' + id };
      } catch {}
    }
    return { commit: null, subject: null, deployedAt: null, source: null };
  }
  async function gitFacts(commit) {
    if (cached && cached.commit === commit && Date.now() - cached.at < cacheMs) return cached.facts;
    const head = await sh('git', ['-C', repo, 'rev-parse', '--verify', 'main^{commit}'], { timeoutMs: 10000 });
    const repoHead = head.code === 0 ? head.stdout.trim() : null;
    let behind = null;
    if (repoHead && commit) {
      const count = await sh('git', ['-C', repo, 'rev-list', '--count', commit + '..' + repoHead], { timeoutMs: 10000 });
      if (count.code === 0) behind = Number(count.stdout.trim());
    }
    const facts = { repoHead, behind };
    cached = { commit, at: Date.now(), facts };
    return facts;
  }
  return async function version() {
    const live = await liveCommit();
    const facts = await gitFacts(live.commit);
    const latestId = (await listDeploys(deploysDir)).at(-1);
    const latest = latestId ? await deployState(deploysDir, latestId) : null;
    const problem = latest && ['interrupted', 'rolled_back', 'rollback_failed', 'apply_failed', 'schedule_failed'].includes(latest.status);
    return {
      commit: live.commit, subject: live.subject, deployedAt: live.deployedAt, source: live.source,
      repoHead: facts.repoHead, behind: facts.behind,
      interrupted: latest?.status === 'interrupted',
      latestDeploy: problem ? { id: latestId, status: latest.status, detail: latest.detail ?? null, at: latest.at ?? null, commit: latest.commit ?? null } : null,
    };
  };
}
