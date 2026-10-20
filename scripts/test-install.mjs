import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootstrap, childEnvironment, configuration } from './setup.mjs';
import { environmentValue, installService, parseArguments, servicePlan, systemdArgument } from './install-service.mjs';
import { checkRuntime } from './check-runtime.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mars install space '));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const configAt = directory => configuration({ HOME: directory, MARS_PI_ROOT: join(directory, 'private data') });

test('bootstrap preserves private token, user docs and native data across repeated setup', () => fixture(async directory => {
  const config = configAt(directory);
  const first = await bootstrap(config);
  assert.match(first.signInUrl, /^http:\/\/127\.0\.0\.1:3081\/\?token=/);
  await writeFile(join(config.root, 'data/agent.sqlite'), 'native data retained');
  await writeFile(join(config.root, 'workspace/HOST-GUIDE.md'), 'owner guide');
  await chmod(join(config.root, 'data/web-token'), 0o644);
  const second = await bootstrap(config);
  assert.equal(second.token, first.token);
  assert.equal(await readFile(join(config.root, 'data/agent.sqlite'), 'utf8'), 'native data retained');
  assert.equal(await readFile(join(config.root, 'workspace/HOST-GUIDE.md'), 'utf8'), 'owner guide');
  assert.equal((await stat(join(config.root, 'data/web-token'))).mode & 0o777, 0o600);
  assert.equal((await stat(config.root)).mode & 0o777, 0o700);
  const env = childEnvironment(second, { PATH: '/bin' });
  assert.equal(env.MARS_PI_TOKEN, first.token);
  assert.equal(env.MARS_PI_ORIGIN, 'http://127.0.0.1:3081');
  assert.equal(env.MARS_UI_DIR, config.ui);
}));

test('configuration rejects in-repository data, invalid ports and broad public origins', () => {
  assert.throws(() => configuration({ MARS_PI_ROOT: process.cwd() }), /outside/);
  assert.throws(() => configuration({ MARS_PI_PORT: '0' }), /ports/);
  assert.throws(() => configuration({ MARS_PI_PORT: '3082' }), /differ/);
  assert.throws(() => configuration({ MARS_PUBLIC_ORIGIN: 'https://example.com/path' }), /bare/);
  assert.equal(configuration({ HOME: '/tmp/mars-user' }).root, '/tmp/mars-user/.local/share/mars');
  assert.equal(configuration({ XDG_DATA_HOME: '/tmp/private-xdg' }).root, '/tmp/private-xdg/mars');
  assert.throws(() => checkRuntime('24.22.0'), /24\.14\.0/);
});

test('service install handles spaces, preserves owner environment and is idempotent without systemd', () => fixture(async directory => {
  const config = { ...configAt(directory), repo: join(directory, 'repo with spaces % and $'), ui: join(directory, 'repo with spaces % and $/apps/ui') };
  await symlink(process.cwd(), config.repo);
  // Only bootstrap's guide source uses this fixture's real source directory.
  const options = { configDir: join(directory, 'units with spaces'), node: '/opt/Node Space/bin/node', systemd: false };
  const first = await installService(config, options);
  assert.equal((await stat(first.environmentFile)).mode & 0o777, 0o600);
  const content = await readFile(first.units[0].path, 'utf8');
  assert.match(content, /"\/opt\/Node Space\/bin\/node"/);
  assert.match(content, /repo with spaces %% and \$\$/);
  assert.match(content, /KillMode=control-group/);
  assert.doesNotMatch(content, /--hostname 0\.0\.0\.0/);
  const token = await readFile(join(config.root, 'data/web-token'), 'utf8');
  await writeFile(first.environmentFile, (await readFile(first.environmentFile, 'utf8')) + 'OWNER_SECRET="preserved value"\n');
  await installService(config, options);
  assert.equal(await readFile(join(config.root, 'data/web-token'), 'utf8'), token);
  assert.match(await readFile(first.environmentFile, 'utf8'), /OWNER_SECRET="preserved value"/);
  assert.equal(await readFile(first.units[0].path, 'utf8'), content);
  assert.equal((await readFile(first.environmentFile, 'utf8')).match(/MARS_PI_ROOT=/g).length, 1);
  assert.match(await readFile(first.environmentFile, 'utf8'), /MARS_FLOCK_PATH="\//);
}));

test('bootstrap creates a separate runtime once and preserves it after checkout or runtime edits', () => fixture(async directory => {
  const source = join(directory, 'source host');
  await mkdir(source);
  for (const file of ['HOST-GUIDE.md', 'EXTENSION-GUIDE.md', 'server.mjs']) await writeFile(join(source, file), 'first source version');
  const config = { ...configAt(directory), host: source };
  const first = await bootstrap(config);
  assert.equal(first.runtime, join(config.root, 'app'));
  assert.notEqual(first.runtime, source);
  assert.equal(await readFile(join(first.runtime, 'server.mjs'), 'utf8'), 'first source version');
  assert.equal(await readFile(join(first.runtime, '.workspace-lock.json'), 'utf8'), await readFile(join(config.repo, 'package-lock.json'), 'utf8'));
  assert.equal(await readlink(join(first.runtime, 'node_modules')), join(config.repo, 'node_modules'));
  await writeFile(join(source, 'server.mjs'), 'new checkout version');
  await bootstrap(config);
  assert.equal(await readFile(join(first.runtime, 'server.mjs'), 'utf8'), 'first source version');
  await writeFile(join(first.runtime, 'server.mjs'), 'owner runtime version');
  await bootstrap(config);
  assert.equal(await readFile(join(first.runtime, 'server.mjs'), 'utf8'), 'owner runtime version');
}));

test('concurrent first bootstrap publishes one complete token and runtime snapshot', () => fixture(async directory => {
  const config = configAt(directory);
  const runs = await Promise.all(Array.from({ length: 4 }, () => bootstrap(config)));
  assert.equal(new Set(runs.map(run => run.token)).size, 1);
  assert.match(runs[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(runs.map(run => run.runtime)).size, 1);
  assert.equal(await readFile(join(runs[0].runtime, 'server.mjs'), 'utf8'), await readFile(join(config.host, 'server.mjs'), 'utf8'));
}));

test('missing flock rejects setup before creating private state, with no unlocked fallback', () => fixture(async directory => {
  const config = { ...configAt(directory), flockPath: join(directory, 'missing flock'), executablePath: '' };
  await assert.rejects(bootstrap(config), /requires a util-linux-compatible flock/);
  await assert.rejects(stat(config.root), { code: 'ENOENT' });
}));

test('dry run creates no private data or services and rejects invalid input', () => fixture(async directory => {
  const config = configAt(directory);
  const plan = await installService(config, { dryRun: true, configDir: join(directory, 'dry-run') });
  assert.equal(plan.units.length, 2);
  await assert.rejects(stat(config.root), { code: 'ENOENT' });
  assert.throws(() => servicePlan({ ...config, hostService: '../bad.service' }), /Invalid/);
  assert.throws(() => systemdArgument('bad\npath'), /single lines/);
  assert.equal(systemdArgument('/a b/"%$'), '"/a b/\\"%%$$"');
  assert.equal(environmentValue('with $dollar and "quote"'), String.raw`"with $dollar and \"quote\""`);
  assert.deepEqual(parseArguments(['--dry-run', '--config-dir', '/tmp/a b', '--mode', 'development']), { dryRun: true, configDir: '/tmp/a b', mode: 'development' });
  assert.throws(() => parseArguments(['--mode']), /requires/);
}));

test('real systemd parser accepts units with spaces and literal percent and dollar signs', { skip: !existsSync('/usr/bin/systemd-analyze') }, () => fixture(async directory => {
  const repo = join(directory, 'repo with spaces % $');
  await symlink(process.cwd(), repo);
  const config = { ...configAt(directory), repo };
  const plan = await installService(config, { configDir: join(directory, 'units'), systemd: false });
  const result = spawnSync('/usr/bin/systemd-analyze', ['--user', 'verify', ...plan.units.map(unit => unit.path)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
}));

async function eventually(check, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error('Timed out waiting for process fixture');
}
async function stopped(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
    return false;
  } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return true; throw error; }
}

test('launcher stops owned children and a TERM-resistant grandchild on shutdown', { skip: process.platform === 'win32' }, () => fixture(async directory => {
  const pidFile = join(directory, 'grandchild.pid');
  const childCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const launcher = join(directory, 'launcher.mjs');
  await writeFile(launcher, `import {supervise} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)}; process.exitCode=await supervise([{label:'fixture',file:process.execPath,args:['-e',${JSON.stringify(childCode)}]}],{graceMs:300});`);
  const child = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stderr.on('data', bytes => { log += bytes; });
  const done = new Promise(resolve => child.once('close', code => resolve(code)));
  let descendant;
  try {
    await eventually(async () => { try { descendant = Number(await readFile(pidFile, 'utf8')); return descendant > 0; } catch { return false; } });
    child.kill('SIGTERM');
    assert.equal(await done, 0, log);
    await eventually(() => stopped(descendant));
  } finally { child.kill('SIGKILL'); if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } }
}));

test('launcher closes a surviving peer after another command fails', () => fixture(async directory => {
  const pidFile = join(directory, 'peer.pid');
  const launcher = join(directory, 'failing-launcher.mjs');
  const peer = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  await writeFile(launcher, `import {supervise} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};process.exitCode=await supervise([{label:'fail',file:process.execPath,args:['-e','setTimeout(()=>process.exit(7),300)']},{label:'peer',file:process.execPath,args:['-e',${JSON.stringify(peer)}]}],{graceMs:300});`);
  const child = spawn(process.execPath, [launcher], { stdio: 'ignore' });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 7);
  const peerPid = Number(await readFile(pidFile, 'utf8'));
  await eventually(() => stopped(peerPid));
}));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return String(port);
}

test('documented host launcher locks one root across different ports and releases ownership after SIGKILL', () => fixture(async directory => {
  const source = join(directory, 'source host'); await mkdir(source);
  for (const file of ['HOST-GUIDE.md', 'EXTENSION-GUIDE.md']) await writeFile(join(source, file), 'fixture guide');
  await writeFile(join(source, 'server.mjs'), `
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.MARS_PI_ROOT + '/data/agent.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS starts (id INTEGER PRIMARY KEY); INSERT INTO starts DEFAULT VALUES');
const server = http.createServer((_req,res) => res.end(JSON.stringify({pid:process.pid, starts:db.prepare('SELECT COUNT(*) AS count FROM starts').get().count})));
server.listen(Number(process.env.MARS_PI_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
`);
  const launcher = join(directory, 'locked-launcher.mjs');
  await writeFile(launcher, `
import { bootstrap, childEnvironment, configuration } from ${JSON.stringify(new URL('./setup.mjs', import.meta.url).href)};
import { commands, supervise } from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};
const config = await bootstrap({...configuration(),host:process.env.MARS_FIXTURE_SOURCE});
process.exitCode = await supervise(commands(config,'production','host'),{env:childEnvironment(config),graceMs:500});
`);
  const root = join(directory, 'locked private root'), firstPort = await freePort();
  let secondPort;
  do { secondPort = await freePort(); } while (firstPort === secondPort);
  const runs = [], hostPids = [];
  function start(port) {
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, MARS_FIXTURE_SOURCE: source, MARS_PI_ROOT: root, MARS_PI_PORT: port, MARS_UI_PORT: port === '3082' ? '3083' : '3082', MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { child, output: '', done: new Promise(resolve => child.once('close', resolve)) };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { run.output += bytes; });
    runs.push(run); return run;
  }
  const address = port => `http://127.0.0.1:${port}/`;
  async function state(port) { return (await fetch(address(port), { signal: AbortSignal.timeout(500) })).json(); }
  try {
    const first = start(firstPort);
    await eventually(async () => { try { const value = await state(firstPort); hostPids.push(value.pid); return value.starts === 1; } catch { return false; } });
    const second = start(secondPort);
    assert.equal(await second.done, 73, second.output);
    assert.match(second.output, /Another Pi host already owns/);
    assert.equal((await state(firstPort)).starts, 1, 'rejected second host never opens SQLite');
    await assert.rejects(fetch(address(secondPort), { signal: AbortSignal.timeout(500) }));
    process.kill(hostPids[0], 'SIGKILL');
    assert.equal(await first.done, 1);
    const restarted = start(secondPort);
    await eventually(async () => { try { const value = await state(secondPort); hostPids.push(value.pid); return value.starts === 2; } catch { return false; } });
    restarted.child.kill('SIGTERM');
    assert.equal(await restarted.done, 0, restarted.output);
    await assert.rejects(fetch(address(secondPort), { signal: AbortSignal.timeout(500) }));
  } finally {
    for (const run of runs) if (run.child.exitCode === null) run.child.kill('SIGTERM');
    for (const pid of hostPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await Promise.all(runs.map(run => run.done));
  }
}));
