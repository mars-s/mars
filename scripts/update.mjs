// Mars updater (docs/UPDATES.md). check() is read-only; apply() prepares the new version
// beside the running one, then switches over under a journal that recover() can undo.
// Every operation that touches services, npm, Next or health is in `ops`, so tests can
// replace them; the Git and file moves are always real.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { uptime } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED, NEVER } from '../packages/pi-host/protected-files.mjs';
import { INSTALLABLE, classify, describe, gatherFacts, git } from './update-check.mjs';

const exists = path => lstat(path).then(() => true, () => false);
const tail = (text, n = 2000) => (text.length > n ? '...' + text.slice(-n) : text);
const short = sha => (sha || '').slice(0, 12);
const split = text => text.split('\0').filter(Boolean);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
const readJson = path => readFile(path, 'utf8').then(JSON.parse, () => null);

/** Run a command without a shell. Never throws for a non-zero exit. */
export function run(file, args, { cwd, env, timeoutMs = 20 * 60 * 1000, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const keep = data => { output += data; if (output.length > 2e6) output = output.slice(-1e6); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, output: output + error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 128, output }); });
    child.stdin.on('error', () => {}); // a command that exits without reading stdin (EPIPE on Linux)
    child.stdin.end(input ?? '');
  });
}

/** Move a directory, copying when it crosses file systems. */
async function move(from, to) {
  try { await rename(from, to); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

// Only dependency fields and the lockfile need a new install; scripts and metadata do not.
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'workspaces'];
async function dependencyKey(dir) {
  const lockText = await readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => '');
  const lock = lockText ? JSON.parse(lockText) : { packages: {} };
  const manifests = [];
  for (const path of ['', ...Object.keys(lock.packages || {}).filter(path => path && !path.includes('node_modules'))]) {
    const manifest = await readJson(join(dir, path, 'package.json')) ?? {};
    manifests.push([path, DEPENDENCY_FIELDS.map(field => manifest[field] ?? null)]);
  }
  return JSON.stringify([lockText, manifests]);
}

/** Every .mjs file under these folders, skipping dependencies and dot folders. */
async function moduleFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === 'node_modules' || entry.name === 'public' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await moduleFiles(path, out);
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** The real operations. Tests replace any of these. */
export function defaultOps(config, env = process.env) {
  const systemctl = args => run('systemctl', ['--user', ...args], { timeoutMs: 120000 });
  const healthSeconds = Number(env.MARS_UPDATE_HEALTH_SECONDS || 90);
  return {
    async managed() {
      if (process.platform !== 'linux') return false;
      for (const unit of [config.hostService, config.uiService]) if ((await systemctl(['cat', unit])).code !== 0) return false;
      return true;
    },
    /** True when this process runs inside a Mars service, which stopping would kill. */
    async insideService() {
      const cgroup = await readFile('/proc/self/cgroup', 'utf8').catch(() => '');
      return [config.hostService, config.uiService].some(unit => cgroup.includes('/' + unit));
    },
    async portsInUse() {
      const busy = [];
      for (const port of [config.hostPort, config.uiPort]) {
        try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); busy.push(port); } catch {}
      }
      return busy;
    },
    async stop() {
      const result = await systemctl(['stop', config.uiService, config.hostService]);
      if (result.code !== 0) throw Error('systemctl stop failed: ' + tail(result.output, 500));
    },
    async start() {
      const result = await systemctl(['start', config.hostService, config.uiService]);
      if (result.code !== 0) throw Error('systemctl start failed: ' + tail(result.output, 500));
    },
    async health() {
      const deadline = Date.now() + healthSeconds * 1000;
      let detail = 'no answer';
      while (Date.now() < deadline) {
        try {
          const token = (await readFile(join(config.root, 'data/web-token'), 'utf8')).trim();
          const headers = { authorization: 'Bearer ' + token };
          const host = await fetch(`http://127.0.0.1:${config.hostPort}/api/state`, { headers, signal: AbortSignal.timeout(10000) });
          const ui = host.ok ? await fetch(`http://127.0.0.1:${config.hostPort}/`, { headers, signal: AbortSignal.timeout(20000) }) : null;
          if (host.ok && ui?.ok) return { ok: true, detail: 'host and UI answer 200' };
          detail = host.ok ? `UI page returned ${ui.status}` : `host /api/state returned ${host.status}`;
        } catch (error) { detail = String(error.message || error); }
        await sleep(2000);
      }
      return { ok: false, detail: `Not healthy after ${healthSeconds}s: ${detail}` };
    },
    install: tree => run(env.MARS_NPM || 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: tree }),
    build: tree => run(process.execPath, [join(tree, 'scripts/build.mjs')], {
      cwd: tree, env: { MARS_REPO_ROOT: tree, MARS_UI_DIR: join(tree, 'apps/ui'), MARS_PI_ROOT: config.root, NODE_ENV: 'production' },
    }),
    async bootTest(app, tree) {
      const stageRoot = join(dirname(app), 'boot-root');
      for (const name of ['data', 'workspace', 'evidence']) await mkdir(join(stageRoot, name), { recursive: true, mode: 0o700 });
      const port = await freePort(), uiPort = await freePort();
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MARS_PI_ROOT: stageRoot, MARS_PI_PORT: String(port), MARS_UI_PORT: String(uiPort), MARS_PI_STAGING: '1', MARS_REPO_ROOT: tree, MARS_UI_DIR: join(tree, 'apps/ui'), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' },
      });
      let log = '';
      child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
      const exited = new Promise(resolve => child.once('close', resolve));
      try {
        const started = Date.now();
        const ready = await Promise.race([
          (async () => { while (!/agent ready/.test(log)) { if (Date.now() - started > 60000) return 'did not start in 60s'; await sleep(100); } return 'ready'; })(),
          exited.then(code => 'exited with code ' + code),
        ]);
        if (ready !== 'ready') return { ok: false, detail: `Test boot ${ready}. ${tail(log, 1500)}` };
        const token = (await readFile(join(stageRoot, 'data/web-token'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
        return response.ok ? { ok: true, detail: `Booted in ${Date.now() - started}ms` } : { ok: false, detail: `Test boot /api/state returned ${response.status}. ${tail(log, 1500)}` };
      } finally {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited; clearTimeout(timer);
        await rm(stageRoot, { recursive: true, force: true });
      }
    },
    async checks(app, tree) {
      const temporary = join(dirname(app), 'check-root');
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      // The candidate's checks judge the candidate tree, as a staging host, never the live checkout.
      const result = await run(process.execPath, ['run-checks.mjs', '--json'], { cwd: app, env: { MARS_PI_ROOT: temporary, MARS_REPO_ROOT: tree, MARS_UI_DIR: join(tree, 'apps/ui'), MARS_PI_STAGING: '1', MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' } });
      await rm(temporary, { recursive: true, force: true });
      return { ok: result.code === 0, detail: tail(result.output, 2000) };
    },
  };
}

export const PREPARE_STEPS = ['check', 'merge', 'tree', 'dependencies', 'syntax', 'build', 'runtime', 'boot', 'checks'];
export const SWITCH_STEPS = ['stop', 'checkout', 'swap_dependencies', 'swap_ui', 'swap_runtime', 'start', 'health'];

/**
 * The updater for one installation. `config` is setup.mjs configuration(): repo, root, ui,
 * hostPort, uiPort, hostService, uiService. `ops` overrides defaultOps(config).
 */
export function createUpdater(config, { ops: overrides = {}, env = process.env, log = () => {} } = {}) {
  const ops = { ...defaultOps(config, env), ...overrides };
  const remote = env.MARS_UPDATE_REMOTE || 'origin';
  const branch = env.MARS_UPDATE_BRANCH || 'main';
  const updates = join(config.root, 'updates');
  const paths = {
    status: join(updates, 'status.json'), journal: join(updates, 'current.json'), installed: join(updates, 'installed.json'),
    lock: join(updates, '.lock'), settings: join(updates, 'settings.json'), reconcile: join(updates, 'reconcile.json'),
    worktree: join(updates, 'reconcile'),
  };
  const runtime = config.runtime || join(config.root, 'app');
  const nextBuild = join(config.ui, '.next-build');

  async function check({ fetch = true } = {}) {
    const facts = await gatherFacts({ repo: config.repo, root: config.root, remote, branch, fetch });
    const verdict = classify(facts);
    const status = describe(facts, verdict);
    await atomicJson(paths.status, status);
    return { status, facts };
  }

  // One update or recovery at a time. The lock names its process, its boot and a nonce.
  // A dead holder's lock is taken over by whoever first creates `.takeover-<nonce>`, so two
  // processes that both see it dead cannot both take it (the UI and host roles after a crash).
  let held = null;
  async function lock(id) {
    await mkdir(updates, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 5; attempt++) {
      const mine = { pid: process.pid, boot: bootMinute(), nonce: randomBytes(8).toString('hex'), id, at: new Date().toISOString() };
      // Write the bytes first, then publish them with link(), which fails if a lock exists,
      // so no reader ever sees a half-written lock.
      const temporary = `${paths.lock}.${mine.nonce}`;
      await writeFile(temporary, JSON.stringify(mine), { mode: 0o600 });
      try {
        await link(temporary, paths.lock);
        held = mine;
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally { await rm(temporary, { force: true }); }
      const current = await readJson(paths.lock);
      if (!current) { await sleep(50); continue; }
      if (holds(current)) return false;
      // Exactly one process creates the marker for this dead lock, and it is never removed
      // during the takeover, so a slower process cannot claim it later and delete the new lock.
      const marker = join(updates, `.takeover-${String(current.nonce || current.pid).replace(/[^\w-]/g, '')}`);
      const claimed = await writeFile(marker, String(process.pid), { flag: 'wx', mode: 0o600 }).then(() => true, error => {
        if (error.code !== 'EEXIST') throw error;
        return false;
      });
      if (claimed) {
        // Second guard: only remove the lock that was seen dead.
        const again = await readJson(paths.lock);
        if (again?.nonce === current.nonce) await rm(paths.lock, { force: true });
      } else await sleep(100);
    }
    return false;
  }
  async function unlock() {
    const current = await readJson(paths.lock);
    if (held && current?.nonce === held.nonce) await rm(paths.lock, { force: true });
    held = null;
  }
  async function holder() {
    const current = await readJson(paths.lock);
    return current && holds(current) ? current : null;
  }

  async function record(journal, patch) {
    Object.assign(journal, patch, { updatedAt: new Date().toISOString() });
    await atomicJson(paths.journal, journal);
  }
  async function step(journal, name, work) {
    const entry = { name, status: 'running', at: new Date().toISOString() };
    journal.steps.push(entry);
    await record(journal, { step: name });
    log(`${name}...`);
    try {
      const detail = await work();
      entry.status = detail === 'skipped' ? 'skipped' : 'done';
      if (detail && detail !== 'skipped') entry.detail = String(detail).slice(0, 500);
      await record(journal, {});
      return detail;
    } catch (error) {
      entry.status = 'failed';
      entry.detail = String(error.message || error).slice(0, 2000);
      await record(journal, {});
      throw error;
    }
  }
  const done = (journal, name) => journal.steps.some(entry => entry.name === name && entry.status !== 'running' && entry.status !== 'failed');
  const started = (journal, name) => journal.steps.some(entry => entry.name === name);

  async function identityEnv() {
    const email = (await git(config.repo, ['config', 'user.email'])).stdout.trim();
    return email ? {} : { GIT_AUTHOR_NAME: 'Mars updater', GIT_AUTHOR_EMAIL: 'mars-updater@localhost', GIT_COMMITTER_NAME: 'Mars updater', GIT_COMMITTER_EMAIL: 'mars-updater@localhost' };
  }

  async function finish(journal, outcome, detail, extra = {}) {
    await record(journal, { phase: 'done', outcome, detail, finishedAt: new Date().toISOString(), ...extra });
    const status = await readJson(paths.status);
    if (status) await atomicJson(paths.status, { ...status, lastAttempt: summary(journal) });
    await prune(journal.id);
    return summary(journal);
  }
  function summary(journal) {
    const next = {
      updated: journal.restarted === false ? 'Updated. Start Mars again (npm run dev or npm start) to use the new version.' : 'Updated and healthy. Nothing else to do.',
      failed: 'Nothing live changed. Fix what detail names, or wait for the next commit on main, then update again.',
      rolled_back: 'The new version was unhealthy, so the old one is running again. Read detail, fix the cause on main, then update again.',
      rollback_failed: 'The new version was unhealthy and putting the old one back also failed. Mars may be down. Read detail and run npm run update -- recover on the server.',
      interrupted: 'An update was interrupted and has been undone. Check again, then update.',
    }[journal.outcome];
    return { id: journal.id, outcome: journal.outcome, detail: journal.detail, from: short(journal.from), target: short(journal.target), result: short(journal.result), steps: journal.steps, restarted: journal.restarted, next };
  }
  async function prune(keepId) {
    for (const name of await readdir(updates).catch(() => [])) {
      if (!name.startsWith('.takeover-')) continue;
      const age = Date.now() - (await lstat(join(updates, name)).then(info => info.mtimeMs, () => Date.now()));
      if (age > 3600 * 1000) await rm(join(updates, name), { force: true });
    }
    const ids = (await readdir(updates, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^\d{8}T/.test(entry.name)).map(entry => entry.name).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - 3))) if (id !== keepId) await rm(join(updates, id), { recursive: true, force: true });
  }

  /** Prepare and install the update. Returns the attempt summary or a refusal. */
  async function apply({ id = newId(), full = false } = {}) {
    if (!(await lock(id))) return { outcome: 'busy', detail: 'Another update is running.', next: 'Wait for it to finish, then call mars_update_status.' };
    try { return await applyLocked(id, full); } finally { await unlock(); }
  }

  async function applyLocked(id, full) {
    const dir = join(updates, id), tree = join(dir, 'tree'), app = join(dir, 'app');
    const names = parts(id);
    const managed = await ops.managed();
    // An earlier update died mid switch-over: settle it before looking at anything else.
    const pending = await readJson(paths.journal);
    if (pending && PENDING.has(pending.phase)) {
      const settled = await settle(pending, { services: managed });
      return { ...settled, next: `${settled.next} An earlier interrupted update was settled first; check again before updating.` };
    }
    if (managed && await ops.insideService()) return refuse('inside_service', 'This command runs inside a Mars service, which the update stops. Use the mars_update_apply tool or Settings, Updates.');
    if (!managed) {
      const busy = await ops.portsInUse();
      if (busy.length) return refuse('running', `Mars is running (port ${busy.join(' and ')}) and is not a systemd user service, so the updater cannot restart it. Stop Mars, then run npm run update -- apply.`);
    }
    const { status, facts } = await check();
    if (!INSTALLABLE.has(status.state)) return { outcome: 'nothing_to_do', state: status.state, detail: status.next, blockers: status.blockers, next: status.next };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const journal = { id, phase: 'preparing', from: facts.head, target: facts.target, result: null, state: status.state, managed, steps: [], startedAt: new Date().toISOString(), pid: process.pid };
    await record(journal, {});
    let depsChanged = false;
    try {
      await step(journal, 'check', async () => `${status.state}, ${status.behind} behind, ${status.ahead} ahead`);
      const result = await step(journal, 'merge', async () => {
        if (status.state === 'fast_forward') return facts.target;
        if (facts.reconciled) {
          const problems = await mergeProblems(facts.reconciled, facts.head, facts.target);
          if (problems.length) throw Error(`The reconciled commit is not safe to install: ${problems[0].detail}`);
          return facts.reconciled;
        }
        const commit = await git(config.repo, ['commit-tree', facts.mergeTree, '-p', facts.head, '-p', facts.target, '-m', `Merge ${remote}/${branch} (Mars updater)`], { env: await identityEnv() });
        if (commit.code !== 0) throw Error('git commit-tree failed: ' + commit.stderr.trim());
        return commit.stdout.trim();
      });
      await record(journal, { result });
      await step(journal, 'tree', async () => {
        await mkdir(tree, { recursive: true });
        const archive = await run('bash', ['-o', 'pipefail', '-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', '_', config.repo, result, tree]);
        if (archive.code !== 0) throw Error('git archive failed: ' + tail(archive.output, 500));
        const local = [...facts.uncommitted, ...facts.untracked];
        for (const path of local) {
          const source = join(config.repo, path), target = join(tree, path);
          if (await exists(source)) { await mkdir(dirname(target), { recursive: true }); await rm(target, { recursive: true, force: true }); await cp(source, target, { recursive: true, verbatimSymlinks: true }); }
          else await rm(target, { recursive: true, force: true });
        }
        return local.length ? `${local.length} local file(s) kept` : 'clean';
      });
      depsChanged = await step(journal, 'dependencies', async () => {
        const changed = !(await exists(join(config.repo, 'node_modules'))) || (await dependencyKey(tree)) !== (await dependencyKey(config.repo));
        if (!changed) { await symlink(join(config.repo, 'node_modules'), join(tree, 'node_modules'), 'dir'); return false; }
        const install = await ops.install(tree);
        if (install.code !== 0) throw Error('npm ci failed: ' + tail(install.output));
        return true;
      });
      await step(journal, 'syntax', async () => {
        const files = [...await moduleFiles(join(tree, 'scripts')), ...await moduleFiles(join(tree, 'packages/pi-host'))];
        for (const file of files) {
          const result = await run(process.execPath, ['--check', file], { timeoutMs: 30000 });
          if (result.code !== 0) throw Error(`${relative(tree, file)}: ${tail(result.output, 800)}`);
        }
        return `${files.length} files`;
      });
      await step(journal, 'build', async () => {
        const result = await ops.build(tree);
        if (result.code !== 0) throw Error('UI build failed: ' + tail(result.output));
        if (!(await exists(join(tree, 'apps/ui/.next-build/BUILD_ID')))) throw Error('UI build finished without apps/ui/.next-build/BUILD_ID');
      });
      await step(journal, 'runtime', async () => {
        await cp(join(tree, 'packages/pi-host'), app, { recursive: true, verbatimSymlinks: true, filter: path => !relative(join(tree, 'packages/pi-host'), path).startsWith('node_modules') });
        const shipped = new Set(await readdir(app));
        for (const name of await readdir(runtime).catch(() => [])) {
          if (shipped.has(name) || name === 'node_modules' || name.startsWith('node_modules.prev') || name.startsWith('.backup-')) continue;
          await cp(join(runtime, name), join(app, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        }
        await writeFile(join(app, '.workspace-lock.json'), await readFile(join(tree, 'package-lock.json')));
        await symlink(join(tree, 'node_modules'), join(app, 'node_modules'), 'dir');
      });
      await step(journal, 'boot', async () => {
        const boot = await ops.bootTest(app, tree);
        if (!boot.ok) throw Error(boot.detail);
        return boot.detail;
      });
      await step(journal, 'checks', async () => {
        if (!full) return 'skipped';
        const checks = await ops.checks(app, tree);
        if (!checks.ok) throw Error('Host checks failed: ' + checks.detail);
      });
      // The installed runtime uses the checkout's dependencies, as setup.mjs makes it.
      await rm(join(app, 'node_modules'), { force: true });
      await symlink(join(config.repo, 'node_modules'), join(app, 'node_modules'), 'dir');
      // Put each new part beside the part it replaces. Copying across disks happens here,
      // while nothing live has changed; the switch-over is then renames only.
      await step(journal, 'stage', async () => {
        if (depsChanged) await move(join(tree, 'node_modules'), names.deps.incoming);
        await move(join(tree, 'apps/ui/.next-build'), names.ui.incoming);
        await move(app, names.runtime.incoming);
      });
      await step(journal, 'verify', async () => verifyCheckout(journal));
    } catch (error) {
      await discardIncoming(id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return finish(journal, 'failed', `${journal.step}: ${String(error.message || error)}`.slice(0, 3000));
    }

    await record(journal, { phase: 'switching', depsChanged, restarted: managed });
    try {
      await step(journal, 'stop', async () => { if (!managed) return 'skipped'; await ops.stop(); });
      await step(journal, 'checkout', async () => {
        await verifyCheckout(journal);
        const merged = await git(config.repo, ['merge', '--ff-only', '--quiet', journal.result], { timeoutMs: 120000 });
        if (merged.code !== 0) throw Error('git merge --ff-only failed: ' + merged.stderr.trim());
      });
      for (const [name, part] of [['swap_dependencies', names.deps], ['swap_ui', names.ui], ['swap_runtime', names.runtime]]) {
        await step(journal, name, async () => {
          if (name === 'swap_dependencies' && !depsChanged) return 'skipped';
          if (await exists(part.live)) await rename(part.live, part.previous);
          await rename(part.incoming, part.live);
        });
      }
      await step(journal, 'start', async () => { if (!managed) return 'skipped'; await ops.start(); });
      await step(journal, 'health', async () => {
        if (!managed) return 'skipped';
        const health = await ops.health();
        if (!health.ok) throw Error(health.detail);
        return health.detail;
      });
    } catch (error) {
      const reason = `${journal.step}: ${String(error.message || error)}`.slice(0, 2000);
      await record(journal, { phase: 'rolling_back', detail: reason });
      const undone = await undo(journal);
      return finish(journal, undone.ok ? 'rolled_back' : 'rollback_failed', undone.ok ? reason : `${reason} | rollback: ${undone.detail}`);
    }
    // From here the update has happened. A kill now is finished forwards, never undone.
    await record(journal, { phase: 'committed' });
    return finishForward(journal);
  }

  async function finishForward(journal) {
    await step(journal, 'cleanup', async () => {
      for (const part of Object.values(parts(journal.id))) await rm(part.previous, { recursive: true, force: true });
      await rm(join(updates, journal.id, 'tree'), { recursive: true, force: true });
    });
    await atomicJson(paths.installed, { commit: journal.result, at: new Date().toISOString(), id: journal.id });
    if (journal.state === 'merge') {
      const saved = await readJson(paths.reconcile);
      if (saved?.commit === journal.result) await clearReconcile();
    }
    await check({ fetch: false }).catch(() => {});
    return finish(journal, 'updated', `Now on ${short(journal.result)}${journal.managed ? '' : '; start Mars again to use it'}.`);
  }

  /** Where each swapped part lives, is staged and is kept while the update can still be undone. */
  function parts(id) {
    const at = live => ({ live, incoming: `${live}.incoming-${id}`, previous: `${live}.prev-${id}` });
    return { deps: at(join(config.repo, 'node_modules')), ui: at(nextBuild), runtime: at(runtime) };
  }
  async function discardIncoming(id) {
    for (const part of Object.values(parts(id))) await rm(part.incoming, { recursive: true, force: true });
  }

  /** The checkout must still be on the tracked branch at the commit the update started from. */
  async function verifyCheckout(journal) {
    const current = (await git(config.repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const head = (await git(config.repo, ['rev-parse', 'HEAD'])).stdout.trim();
    if (current !== branch) throw Error(`The checkout moved to ${current || 'a detached commit'} during the update. Nothing was changed; check again.`);
    if (head !== journal.from) throw Error(`The checkout got a new commit (${short(head)}) during the update. Nothing was changed; check again.`);
  }

  /** Undo the switch-over steps that started, newest first. Safe to run more than once. */
  async function undo(journal, { services = journal.managed } = {}) {
    const problems = [];
    const attempt = async (name, work) => { try { await work(); } catch (error) { problems.push(`${name}: ${error.message}`); } };
    if (services) await attempt('stop', () => ops.stop());
    const names = parts(journal.id);
    for (const [name, part] of [['runtime', names.runtime], ['ui', names.ui], ['dependencies', names.deps]]) {
      await attempt(name, async () => {
        if (!(await exists(part.previous))) return;
        if (await exists(part.live)) await rename(part.live, `${part.live}.failed-${journal.id}`);
        await rename(part.previous, part.live);
      });
    }
    // A checkout step that failed (for example a commit landed while the services stopped)
    // never moved the branch: there is nothing to undo, and the owner's commit is not a problem.
    const checkoutFailed = journal.steps.some((entry) => entry.name === 'checkout' && entry.status === 'failed');
    if (started(journal, 'checkout') && !checkoutFailed) await attempt('checkout', async () => {
      // Only move the branch back from the commit this update put there; never touch other work.
      const current = (await git(config.repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
      const head = (await git(config.repo, ['rev-parse', 'HEAD'])).stdout.trim();
      if (head === journal.from) return;
      if (current !== branch || head !== journal.result) throw Error(`The checkout is at ${short(head)} on ${current || 'no branch'}, not this update's ${short(journal.result)}; left as it is.`);
      const reset = await git(config.repo, ['reset', '--keep', journal.from]);
      if (reset.code !== 0) throw Error('git reset --keep failed: ' + reset.stderr.trim());
    });
    for (const part of Object.values(names)) await rm(`${part.live}.failed-${journal.id}`, { recursive: true, force: true });
    await discardIncoming(journal.id);
    await rm(join(updates, journal.id, 'tree'), { recursive: true, force: true });
    if (services) {
      await attempt('start', () => ops.start());
      if (!problems.length) {
        const health = await ops.health();
        if (!health.ok) problems.push('old version unhealthy too: ' + health.detail);
      }
    }
    return { ok: !problems.length, detail: problems.join('; ') };
  }

  /** Settle an interrupted update while holding the lock: finish it forwards or undo it. */
  async function settle(journal, { services }) {
    if (journal.phase === 'committed') return finishForward(journal);
    const undone = await undo(journal, { services });
    return finish(journal, undone.ok ? 'interrupted' : 'rollback_failed', undone.ok ? `Interrupted during ${journal.step}; undone.` : `Interrupted during ${journal.step}; undo failed: ${undone.detail}`);
  }

  /**
   * Undo an update whose process died during the switch-over. Returns null when there is
   * nothing to undo, including while a live update holds the lock: that update is the one
   * starting the services, and it judges their health itself. When another service is
   * already recovering, wait for it rather than start on half-moved files.
   */
  async function recover({ wait = true, services = false } = {}) {
    const journal = await readJson(paths.journal);
    if (!journal || !(PENDING.has(journal.phase) || journal.phase === 'preparing')) return null;
    const deadline = Date.now() + (wait ? 120000 : 0);
    while (!(await lock('recover-' + journal.id))) {
      const current = await holder();
      if (current && !String(current.id).startsWith('recover-')) return null;
      if (Date.now() > deadline) return { outcome: 'busy', detail: 'Another process is recovering the update.' };
      await sleep(500);
    }
    try {
      const fresh = await readJson(paths.journal);
      if (!fresh || !(PENDING.has(fresh.phase) || fresh.phase === 'preparing')) return null;
      // An update killed while preparing (a reboot, its unit stopped) never touched the live
      // copy: drop what it built beside it and record it, instead of showing "updating" forever.
      if (fresh.phase === 'preparing') {
        await discardIncoming(fresh.id);
        await rm(join(updates, fresh.id, 'tree'), { recursive: true, force: true });
        return await finish(fresh, 'failed', 'Interrupted while preparing; nothing was installed.');
      }
      // From run.mjs the services are starting this recovery, so they are not stopped or
      // started here. The updater unit's own fallback passes services: true.
      // await: a bare return would let finally unlock while settle() still moves files, and a
      // second recovery could then undo the same update again (scripts/test-update.mjs race).
      return await settle(fresh, { services });
    } finally { await unlock(); }
  }

  async function clearReconcile() {
    if (await exists(paths.worktree)) await git(config.repo, ['worktree', 'remove', '--force', paths.worktree]);
    await git(config.repo, ['worktree', 'prune']);
    await git(config.repo, ['branch', '-D', 'update/reconcile']);
    await rm(paths.reconcile, { force: true });
  }

  /** Start the opt-in reconcile path: a worktree with main merged in and its conflicts. */
  async function reconcileStart() {
    const { status, facts } = await check();
    if (status.state !== 'needs_reconcile') return { started: false, state: status.state, conflicts: [], worktree: null, next: `Nothing to reconcile: the state is ${status.state}. ${status.next}` };
    await clearReconcile();
    const added = await git(config.repo, ['worktree', 'add', '-B', 'update/reconcile', paths.worktree, facts.head]);
    if (added.code !== 0) throw Error('git worktree add failed: ' + added.stderr.trim());
    await symlink(join(config.repo, 'node_modules'), join(paths.worktree, 'node_modules'), 'dir').catch(() => {});
    await git(paths.worktree, ['merge', '--no-commit', '--no-ff', facts.target], { env: await identityEnv() });
    const conflicts = (await git(paths.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    await atomicJson(paths.reconcile, { head: facts.head, target: facts.target, worktree: paths.worktree, conflicts, commit: null, startedAt: new Date().toISOString() });
    return {
      started: true, state: status.state, worktree: paths.worktree, conflicts,
      next: `Edit each conflicted file in ${paths.worktree} so it keeps both changes and has no <<<<<<< ======= >>>>>>> lines, then call mars_update_reconcile_finish.`,
    };
  }

  /**
   * What is wrong with a merge result `tree` of `ours` and `theirs`: conflict markers in a
   * changed text file, a protected file that matches neither side (renamed, deleted or
   * edited), a never-commit file, or a syntax error. Compares whole trees, so renames count.
   */
  async function treeProblems(tree, ours, theirs, cwd = config.repo) {
    const problems = [];
    const listing = async ref => new Map(split((await git(config.repo, ['ls-tree', '-r', '-z', ref])).stdout).map(row => {
      const [meta, path] = row.split('\t');
      return [path, meta.split(' ')[2]];
    }));
    const [result, a, b] = await Promise.all([listing(tree), listing(ours), listing(theirs)]);
    for (const path of new Set([...result.keys(), ...a.keys(), ...b.keys()])) {
      const mine = result.get(path), left = a.get(path), right = b.get(path);
      if (mine === left && mine === right) continue;
      const never = NEVER.find(([pattern]) => pattern.test(path));
      if (never && mine) { problems.push({ file: path, detail: `${path} ${never[1]}.` }); continue; }
      if (PROTECTED.some(([pattern]) => pattern.test(path)) && mine !== left && mine !== right)
        problems.push({ file: path, detail: `${path} is protected: keep this copy's version (git checkout HEAD -- <file>) or main's (git checkout MERGE_HEAD -- <file>) whole. Do not edit, rename or delete it.` });
      if (!mine || mine === left || mine === right) continue;
      const text = (await git(config.repo, ['cat-file', 'blob', mine])).stdout;
      if (/^(<{7}|>{7})( |$)|^={7}$/m.test(text)) problems.push({ file: path, detail: 'Still has conflict markers (<<<<<<<, ======= or >>>>>>>).' });
      else if (path.endsWith('.mjs')) {
        const checked = await run(process.execPath, ['--check', '--input-type=module'], { input: text, timeoutMs: 30000, cwd });
        if (checked.code !== 0) problems.push({ file: path, detail: tail(checked.output, 600) });
      }
    }
    return problems;
  }
  /** treeProblems for a merge commit, which must have exactly the parents ours and theirs. */
  async function mergeProblems(commit, ours, theirs) {
    const parents = (await git(config.repo, ['rev-list', '--parents', '-n', '1', commit])).stdout.trim().split(' ').slice(1);
    if (parents[0] !== ours || parents[1] !== theirs) return [{ file: '', detail: 'its parents are not this copy and main' }];
    return treeProblems(`${commit}^{tree}`, ours, theirs);
  }

  /** Commit a finished reconcile after checking markers, protected files and syntax. */
  async function reconcileFinish({ message } = {}) {
    const saved = await readJson(paths.reconcile);
    if (!saved || !(await exists(paths.worktree))) return { ok: false, commit: null, problems: [{ file: '', detail: 'No reconcile is open.' }], next: 'Call mars_update_reconcile_start first.' };
    if (saved.commit) return { ok: true, commit: saved.commit, problems: [], next: 'Already committed. Call mars_update_apply to install it.' };
    const head = (await git(config.repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const target = (await git(config.repo, ['rev-parse', `refs/remotes/${remote}/${branch}`])).stdout.trim();
    if (head !== saved.head || target !== saved.target) return { ok: false, commit: null, problems: [{ file: '', detail: 'The checkout or main moved since this reconcile started.' }], next: 'Call mars_update_reconcile_start again.' };
    // Stage everything first, so the checks below read one tree that includes renames and deletes.
    await git(paths.worktree, ['add', '-A', '--', '.', ':!node_modules']);
    const unmerged = split((await git(paths.worktree, ['diff', '--cached', '--name-only', '-z', '--diff-filter=U'])).stdout);
    const problems = unmerged.map(file => ({ file, detail: 'Still unmerged. Edit it, or keep one side whole with git checkout HEAD -- <file> or git checkout MERGE_HEAD -- <file>.' }));
    if (!problems.length) {
      const tree = (await git(paths.worktree, ['write-tree'])).stdout.trim();
      problems.push(...await treeProblems(tree, saved.head, saved.target, paths.worktree));
    }
    if (problems.length) return { ok: false, commit: null, problems, next: `Fix ${problems[0].file || 'the first problem'} in ${paths.worktree}, then call mars_update_reconcile_finish again.` };
    const committed = await git(paths.worktree, ['commit', '--no-verify', '-q', '-m', message || `Merge ${remote}/${branch} (reconciled)`], { env: await identityEnv() });
    if (committed.code !== 0) return { ok: false, commit: null, problems: [{ file: '', detail: 'git commit failed: ' + committed.stderr.trim() }], next: 'Read the problem, fix it in the worktree and try again.' };
    const commit = (await git(paths.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    await atomicJson(paths.reconcile, { ...saved, commit, finishedAt: new Date().toISOString() });
    return { ok: true, commit, problems: [], next: 'Call mars_update_apply to install the reconciled version.' };
  }

  async function read() {
    const [status, journal, installed, settings, lockHolder] = await Promise.all([readJson(paths.status), readJson(paths.journal), readJson(paths.installed), readJson(paths.settings), holder()]);
    const head = (await git(config.repo, ['rev-parse', 'HEAD'])).stdout.trim();
    return {
      status, installed: installed ?? null, head: short(head), settings: { auto: settings?.auto === true },
      // A live lock means an update is running even before it writes its journal (its first
      // seconds check and fetch), so a second click cannot start another one meanwhile.
      running: lockHolder && (journal?.phase !== 'done' || journal?.id !== lockHolder.id)
        ? (journal?.phase !== 'done' ? { id: journal?.id, phase: journal?.phase, step: journal?.step, steps: journal?.steps ?? [] } : { id: lockHolder.id, phase: 'starting', step: 'check', steps: [] })
        : null,
      last: journal?.phase === 'done' ? summary(journal) : null,
    };
  }
  async function setSettings({ auto }) {
    await atomicJson(paths.settings, { auto: auto === true });
    return { auto: auto === true };
  }
  return { check, apply, recover, reconcileStart, reconcileFinish, read, setSettings, paths };
}

export function newId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(2).toString('hex');
}
const PENDING = new Set(['switching', 'rolling_back', 'committed']);
/** Minutes since the epoch at which this machine booted; a lock from another boot is dead. */
function bootMinute() { return Math.round((Date.now() / 1000 - uptime()) / 60); }
function holds(lock) {
  if (Number.isInteger(lock.boot) && Math.abs(lock.boot - bootMinute()) > 2) return false;
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const HELP = `Usage: npm run update -- <command> [--json]
  status    Show the last check and the last update
  check     Fetch main and say whether an update is ready
  apply     Install the update (--full also runs every host check)
  recover   Undo an update that was interrupted while switching over
  reconcile-start   Merge main into a separate worktree and list the conflicts
  reconcile-finish  Check and commit that merge so apply can install it`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { checkRuntime } = await import('./check-runtime.mjs');
  const { configuration, loadEnvironment } = await import('./setup.mjs');
  checkRuntime(); loadEnvironment();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const command = args.find(arg => !arg.startsWith('--')) || 'status';
  const idIndex = args.indexOf('--id');
  const updater = createUpdater(configuration(), { log: json ? () => {} : line => console.log(line) });
  let result;
  if (command === 'status') result = await updater.read();
  else if (command === 'check') result = (await updater.check()).status;
  else if (command === 'apply') result = await updater.apply({ full: args.includes('--full'), ...(idIndex >= 0 ? { id: args[idIndex + 1] } : {}) });
  // --restart: the updater unit's fallback after `apply` died; stop, undo, start, check health.
  else if (command === 'recover') result = (await updater.recover({ wait: false, services: args.includes('--restart') })) ?? { outcome: 'nothing_to_do', detail: 'No interrupted update.', next: 'Nothing to do.' };
  else if (command === 'reconcile-start') result = await updater.reconcileStart();
  else if (command === 'reconcile-finish') result = await updater.reconcileFinish();
  else { console.error(HELP); process.exit(2); }
  if (json) console.log(JSON.stringify(result));
  else console.log(result.next ? `${result.state || result.outcome || 'status'}: ${result.detail && result.detail !== result.next ? result.detail + '\n' : ''}${result.next}` : JSON.stringify(result, null, 2));
  if (['failed', 'rolled_back', 'rollback_failed', 'busy', 'refused'].includes(result.outcome) || result.ok === false) process.exitCode = 1;
}

function refuse(code, detail) {
  return { outcome: 'refused', code, detail, next: detail };
}
