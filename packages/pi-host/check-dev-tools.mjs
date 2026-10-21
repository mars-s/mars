import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { utimes } from 'node:fs/promises';
import { applyPatch, createDevTools, createHostVersion, procStart, sh, freePort } from './dev-tools.mjs';

const base = await mkdtemp(join(tmpdir(), 'mars-devtools-'));
const git = (cwd, ...args) => sh('git', ['-c', 'user.name=check', '-c', 'user.email=check@local', '-C', cwd, ...args]);
const exists = p => stat(p).then(() => true, () => false);

// apply_patch: paths are relative to cwd, also inside a repo subdirectory; validation never writes.
const repoP = join(base, 'patch-repo');
await mkdir(join(repoP, 'sub'), { recursive: true });
await writeFile(join(repoP, 'sub/a.txt'), 'one\ntwo \u0060x\u0060 $' + '{y}\nthree\n');
await git(repoP, 'init', '-q'); await git(repoP, 'add', '.'); await git(repoP, 'commit', '-qm', 'init');
const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two \u0060x\u0060 $' + '{y}\n+TWO\n three\n' + 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n';
let r = await applyPatch({ patch, cwd: join(repoP, 'sub'), check: true });
assert.equal(r.applied, false);
assert.match(await readFile(join(repoP, 'sub/a.txt'), 'utf8'), /two/);
r = await applyPatch({ patch, cwd: join(repoP, 'sub') });
assert.deepEqual(r.files.map(f => f.path).sort(), ['sub/a.txt', 'sub/new.txt']);
assert.equal(await readFile(join(repoP, 'sub/a.txt'), 'utf8'), 'one\nTWO\nthree\n');
assert.equal(await readFile(join(repoP, 'sub/new.txt'), 'utf8'), 'fresh\n');
await assert.rejects(applyPatch({ patch, cwd: join(repoP, 'sub') }), /does not apply|invalid/);
await assert.rejects(applyPatch({ patch: 'not a patch', cwd: repoP }), /invalid|touches no files/);
const plain = join(base, 'plain'); await mkdir(plain); await writeFile(join(plain, 'a.txt'), 'one\ntwo \u0060x\u0060 $' + '{y}\nthree\n');
r = await applyPatch({ patch, cwd: plain });
assert.equal(await readFile(join(plain, 'new.txt'), 'utf8'), 'fresh\n');

// Deploy pipeline against a fake repo, live app and service manager.
const server = version => String.raw`import http from 'node:http'; import { mkdir, writeFile } from 'node:fs/promises';
const root = process.env.MARS_PI_ROOT, port = Number(process.env.MARS_PI_PORT);
if (process.env.MARS_PI_STAGING !== '1' && process.env.FAIL_LIVE_MARKER !== 'off' && ${version === 'fails-live' ? 'true' : 'false'}) process.exit(3);
${version === 'broken' ? "throw new Error('broken build');" : ''}
await mkdir(root + '/data', { recursive: true }); await writeFile(root + '/data/web-token', 'tok');
http.createServer((req, res) => { const ok = req.headers.authorization === 'Bearer tok'; res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ conversationId: '1', version: '${version}' })); })
  .listen(port, '127.0.0.1', () => console.log('Mars Pi agent ready'));
`;
const repo = join(base, 'repo'), host = join(repo, 'packages/pi-host');
await mkdir(host, { recursive: true });
await copyFile(new URL('./deploy-watchdog.sh', import.meta.url), join(host, 'deploy-watchdog.sh'));
await writeFile(join(host, 'run-checks.mjs'), "console.log(JSON.stringify({ ok: true, total: 1, passed: ['check-fake.mjs'], failed: [] }));\n");
await writeFile(join(host, 'package.json'), '{"scripts":{"check":"node run-checks.mjs"},"dependencies":{}}\n');
await writeFile(join(host, 'server.mjs'), server('v2'));
await writeFile(join(host, 'feature.mjs'), 'export default 2;\n');
await git(repo, 'init', '-q', '-b', 'main'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'v2');

const root = join(base, 'live'), app = join(root, 'app');
await mkdir(join(app, 'node_modules'), { recursive: true });
await writeFile(join(app, 'server.mjs'), server('v1'));
await writeFile(join(app, 'package.json'), '{"dependencies":{}}\n');
await writeFile(join(app, 'live-only.txt'), 'keep me\n');
const port = await freePort();

const fake = join(base, 'bin'); await mkdir(fake);
await writeFile(join(fake, 'systemctl'), String.raw`#!/bin/bash
PID=$FAKE_DIR/pid
case "$2" in
  restart) [ -f $PID ] && kill $(cat $PID) 2>/dev/null; sleep 0.2
    MARS_PI_ROOT=$FAKE_ROOT MARS_PI_PORT=$FAKE_PORT nohup node $FAKE_APP/server.mjs >$FAKE_DIR/server.log 2>&1 & echo $! > $PID ;;
  is-active) kill -0 $(cat $PID) 2>/dev/null ;;
esac
`);
await writeFile(join(fake, 'systemd-run'), '#!/bin/bash\n# Like systemd-run: the exit code reports scheduling, not the job.\necho "$@" > "$FAKE_DIR/args"\nwhile [ "$1" != /bin/bash ]; do shift; done\n"$@"\nexit 0\n');
await chmod(join(fake, 'systemctl'), 0o755); await chmod(join(fake, 'systemd-run'), 0o755);
Object.assign(process.env, { FAKE_DIR: fake, FAKE_ROOT: root, FAKE_PORT: String(port), FAKE_APP: app, MARS_DEPLOY_SYSTEMCTL: join(fake, 'systemctl'), MARS_DEPLOY_HEALTH_ATTEMPTS: '15', MARS_DEPLOY_HEALTH_INTERVAL: '0.2' });
await sh(join(fake, 'systemctl'), ['--user', 'restart', 'fake.service']);

const dev = createDevTools({ root, appDir: app, repo, service: 'fake.service', livePort: port, systemdRun: join(fake, 'systemd-run'), bootTimeoutMs: 15000 });
const call = async (name, args = {}) => (await dev.extension.tools.find(t => t.name === name).execute(args, {}, { abortSignal: new AbortController().signal })).structuredOutput;
const liveVersion = async () => {
  for (let i = 0; ; i++) {
    try { return JSON.parse(await (await fetch('http://127.0.0.1:' + port + '/api/state', { headers: { authorization: 'Bearer tok' } })).text()).version; }
    catch (error) { if (i > 50) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
};
try {
  assert.equal(await liveVersion(), 'v1');
  let v = await call('host_deploy', { dryRun: true });
  assert.equal(v.status, 'dry_run');
  assert.equal(v.boot.ok, true);
  assert.deepEqual(v.changed, ['package.json', 'server.mjs']);
  assert.equal(v.depsChanged, false, 'a scripts-only package.json change needs no npm ci');
  assert.ok(v.added.includes('feature.mjs'));
  assert.deepEqual(v.appOnly, ['live-only.txt']);
  assert.equal(await liveVersion(), 'v1', 'dry run leaves the live app alone');

  v = await call('host_deploy', { restartDelaySeconds: 3 });
  assert.equal(v.status, 'scheduled');
  assert.match(await readFile(join(fake, 'args'), 'utf8'), /--on-active=3s --timer-property=AccuracySec=100ms/, 'restart delay is honoured precisely');
  let s = await call('host_deploy_status');
  assert.equal(s.status, 'deployed', JSON.stringify(s));
  assert.equal(await liveVersion(), 'v2');
  const recorded = JSON.parse(await readFile(join(app, 'deployed.json'), 'utf8'));
  assert.equal(recorded.commit, (await git(repo, 'rev-parse', 'HEAD')).stdout.trim(), 'the watchdog records the deployed commit for the live app');
  assert.equal(recorded.subject, 'v2');
  assert.equal(await readFile(join(app, 'live-only.txt'), 'utf8'), 'keep me\n');
  assert.equal(await exists(join(app, 'feature.mjs')), true);
  assert.equal((await call('host_deploy')).status, 'noop');

  // A build that cannot boot never reaches the live app.
  await writeFile(join(host, 'server.mjs'), server('broken')); await git(repo, 'commit', '-qam', 'broken');
  v = await call('host_deploy');
  assert.equal(v.status, 'staging_failed');
  assert.match(v.boot.error, /exited/);
  assert.equal(await liveVersion(), 'v2');

  // A build that boots in staging but fails live is rolled back automatically, including new files.
  await writeFile(join(host, 'server.mjs'), server('fails-live')); await writeFile(join(host, 'extra-new.mjs'), '1\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'fails live');
  v = await call('host_deploy', { restartDelaySeconds: 3 });
  s = await call('host_deploy_status', { id: v.id });
  assert.equal(s.status, 'rolled_back', JSON.stringify(s));
  assert.match(s.watchdog, /rolling back/);
  assert.equal(await liveVersion(), 'v2');
  assert.equal(await exists(join(app, 'extra-new.mjs')), false);
  assert.ok(s.recent.length >= 4);
  // Monorepo deploys use one committed root lock and install only native deps.
  const workspaceRepo = join(base, 'workspace-repo');
  const workspaceHost = join(workspaceRepo, 'packages/pi-host');
  await mkdir(workspaceHost, { recursive: true });
  await mkdir(join(workspaceRepo, 'apps/ui'), { recursive: true });
  await writeFile(join(workspaceRepo, 'package.json'), JSON.stringify({ name: 'mars-fixture', private: true, workspaces: ['packages/*', 'apps/ui'] }));
  await writeFile(join(workspaceRepo, 'apps/ui/package.json'), JSON.stringify({ name: '@mars/ui-fixture', version: '1.0.0' }));
  await writeFile(join(workspaceHost, 'package.json'), JSON.stringify({ name: '@mars/pi-host', version: '1.0.0', dependencies: {} }));
  for (const name of ['deploy-watchdog.sh', 'run-checks.mjs']) await copyFile(join(host, name), join(workspaceHost, name));
  await writeFile(join(workspaceHost, 'server.mjs'), server('workspace-v3'));
  const lock = await sh('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: workspaceRepo });
  assert.equal(lock.code, 0, lock.stderr);
  await git(workspaceRepo, 'init', '-q', '-b', 'main'); await git(workspaceRepo, 'add', '.'); await git(workspaceRepo, 'commit', '-qm', 'workspace');
  // The old standalone host has the same declared dependencies, but has never
  // installed this workspace lock. A checkout lock is not evidence of installation.
  await rm(join(app, '.workspace-lock.json'), { force: true });
  const workspaceDev = createDevTools({ root, appDir: app, repo: workspaceRepo, service: 'fake.service', livePort: port, systemdRun: join(fake, 'systemd-run'), bootTimeoutMs: 15000 });
  assert.deepEqual(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).dependencies, JSON.parse(await readFile(join(workspaceHost, 'package.json'), 'utf8')).dependencies, 'legacy host declares the same native dependencies');
  const plan = await workspaceDev.stage();
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.depsChanged, true, 'a missing installed workspace marker forces npm ci even when native dependency declarations match');
  assert.equal(await exists(join(plan.dir, 'stage/dependencies/node_modules/@mars/pi-host')), true);
  assert.equal(await exists(join(plan.dir, 'stage/dependencies/node_modules/@mars/ui-fixture')), false, 'UI workspace is not installed by host staging');
  const deployed = await workspaceDev.deploy({ restartDelaySeconds: 3 });
  assert.equal((await workspaceDev.status({ id: deployed.id })).status, 'deployed');
  assert.equal(await liveVersion(), 'workspace-v3');
  assert.equal(await readFile(join(app, '.workspace-lock.json'), 'utf8'), await readFile(join(workspaceRepo, 'package-lock.json'), 'utf8'));
  const priorDeps = await realpath(join(app, 'node_modules'));
  assert.match(priorDeps, /stage\/dependencies\/node_modules$/);
  // Force a fresh native dependency snapshot and prove rollback restores its predecessor.
  await mkdir(join(workspaceRepo, 'packages/native-fixture'), { recursive: true });
  await writeFile(join(workspaceRepo, 'packages/native-fixture/package.json'), JSON.stringify({ name: '@mars/native-fixture', version: '1.0.0' }));
  await writeFile(join(workspaceHost, 'package.json'), JSON.stringify({ name: '@mars/pi-host', version: '1.0.0', dependencies: { '@mars/native-fixture': '1.0.0' } }));
  await writeFile(join(workspaceHost, 'server.mjs'), server('fails-live'));
  assert.equal((await sh('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: workspaceRepo })).code, 0);
  await git(workspaceRepo, 'add', '.'); await git(workspaceRepo, 'commit', '-qm', 'workspace fails live');
  const failed = await workspaceDev.deploy({ restartDelaySeconds: 3 });
  assert.equal((await workspaceDev.status({ id: failed.id })).status, 'rolled_back');
  assert.equal(await realpath(join(app, 'node_modules')), priorDeps);
  assert.equal(await liveVersion(), 'workspace-v3');

  // Interrupted deploys: a dead owner or no status at all is reported, never left as "scheduled".
  const deploysDir = join(root, 'deploys');
  const fakeDeploy = async (id, state) => { await mkdir(join(deploysDir, id), { recursive: true }); if (state) await writeFile(join(deploysDir, id, 'status.json'), JSON.stringify(state)); return id; };
  const old = new Date(Date.now() - 3600e3);
  const silent = await fakeDeploy('20991231T000000001-deadbeef-0001');
  await utimes(join(deploysDir, silent), old, old);
  let st = await dev.status({ id: silent });
  assert.equal(st.status, 'interrupted', JSON.stringify(st));
  assert.match(st.detail, /never recorded a status.*not changed/);
  const gone = spawn(process.execPath, ['-e', '0']); await new Promise(r => gone.once('close', r));
  const staging = await fakeDeploy('20991231T000000002-deadbeef-0002', { status: 'staging', detail: 'Running host checks', startedAt: new Date().toISOString(), at: new Date().toISOString(), pid: gone.pid });
  st = await dev.status({ id: staging });
  assert.equal(st.status, 'interrupted'); assert.equal(st.lastStatus, 'staging');
  assert.match(st.detail, /while staging \(Running host checks\).*no longer running/);
  // A live watchdog blocks a new deploy; once it dies the next deploy proceeds and reports it.
  const sleeper = spawn('sleep', ['60']);
  const applying = await fakeDeploy('20991231T000000003-deadbeef-0003', { status: 'applying', at: new Date().toISOString(), pid: sleeper.pid, pidStart: await procStart(sleeper.pid) });
  assert.equal((await dev.status({ id: applying })).status, 'applying');
  await assert.rejects(call('host_deploy', { dryRun: true }), /still applying/);
  const wrongStart = await fakeDeploy('20991231T000000004-deadbeef-0004', { status: 'restarting', at: new Date().toISOString(), pid: sleeper.pid, pidStart: '1' });
  assert.equal((await dev.status({ id: wrongStart })).status, 'interrupted', 'a reused pid with another start time is not the watchdog');
  sleeper.kill('SIGKILL'); await new Promise(r => sleeper.once('close', r));
  st = await dev.status({ id: applying });
  assert.equal(st.status, 'interrupted'); assert.match(st.detail, /partly updated/);
  const stale = await fakeDeploy('20991231T000000005-deadbeef-0005', { status: 'scheduled', at: old.toISOString(), restartAt: old.toISOString() });
  assert.equal((await dev.status()).status, 'interrupted', 'latest deploy scheduled long ago is reported');
  const versionOf = createHostVersion({ root, appDir: app, repo, deploysDir });
  let ver = await versionOf();
  assert.equal(ver.interrupted, true); assert.equal(ver.latestDeploy.id, stale);
  v = await call('host_deploy', { dryRun: true });
  assert.equal(v.status, 'dry_run', 'an interrupted deploy does not block the next');
  assert.equal(v.previous.id, stale); assert.match(v.previous.detail, /watchdog never started/);
  assert.equal((await dev.status({ id: v.id })).status, 'dry_run');
  for (const id of [silent, staging, applying, wrongStart, stale]) await rm(join(deploysDir, id), { recursive: true });

  // GET /api/host/version facts against a temporary repo: live commit, main and commits behind.
  const vrepo = join(base, 'version-repo'), vapp = join(base, 'version-app');
  await mkdir(vrepo); await mkdir(vapp);
  const commitFile = async (msg) => { await writeFile(join(vrepo, 'f.txt'), msg); await git(vrepo, 'add', '.'); await git(vrepo, 'commit', '-qm', msg); return (await git(vrepo, 'rev-parse', 'HEAD')).stdout.trim(); };
  await git(vrepo, 'init', '-q', '-b', 'main');
  const c1 = await commitFile('one'); await commitFile('two'); const c3 = await commitFile('three');
  const noApp = createHostVersion({ root: join(base, 'none'), appDir: vapp, repo: vrepo });
  ver = await noApp();
  assert.deepEqual([ver.commit, ver.behind, ver.repoHead, ver.interrupted, ver.latestDeploy], [null, null, c3, false, null]);
  await writeFile(join(vapp, 'deployed.json'), JSON.stringify({ commit: c1, subject: 'one', deployedAt: '2026-10-21T10:00:00.000Z' }));
  const cachedVersion = createHostVersion({ root: join(base, 'none'), appDir: vapp, repo: vrepo });
  ver = await cachedVersion();
  assert.deepEqual([ver.commit, ver.subject, ver.deployedAt, ver.repoHead, ver.behind], [c1, 'one', '2026-10-21T10:00:00.000Z', c3, 2]);
  const c4 = await commitFile('four');
  assert.equal((await cachedVersion()).behind, 2, 'git facts are cached');
  ver = await createHostVersion({ root: join(base, 'none'), appDir: vapp, repo: vrepo, cacheMs: 0 })();
  assert.deepEqual([ver.repoHead, ver.behind], [c4, 3]);
  await writeFile(join(vapp, 'deployed.json'), JSON.stringify({ commit: 'f'.repeat(40) }));
  assert.equal((await createHostVersion({ root: join(base, 'none'), appDir: vapp, repo: vrepo })()).behind, null, 'unknown live commit gives behind null');
  console.log('interrupted deploy detection and host version checks passed');
  console.log('dev-tools standalone and monorepo host-only staging, boot, deployment and dependency rollback checks passed');
} finally {
  const pid = await readFile(join(fake, 'pid'), 'utf8').catch(() => '');
  if (pid) try { process.kill(Number(pid)); } catch {}
  await rm(base, { recursive: true, force: true });
}
