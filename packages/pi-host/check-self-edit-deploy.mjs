// self_edit_finish with the real deploy gate (docs/SELF-EDIT.md): the default wiring calls
// createDevTools().deploy, which stages the exact commit, runs its checks and boots it in
// isolation. Dry run only, so no service manager is involved and nothing restarts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevTools, freePort, sh } from './dev-tools.mjs';
import { createSelfEdit } from './self-edit.mjs';

const base = await mkdtemp(join(tmpdir(), 'mars-self-edit-deploy-'));
const git = (cwd, ...args) => sh('git', ['-c', 'user.name=check', '-c', 'user.email=check@local', '-C', cwd, ...args]);
const server = (version) => String.raw`import http from 'node:http'; import { mkdir, writeFile } from 'node:fs/promises';
const root = process.env.MARS_PI_ROOT, port = Number(process.env.MARS_PI_PORT);
await mkdir(root + '/data', { recursive: true }); await writeFile(root + '/data/web-token', 'tok');
http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer tok' ? 200 : 401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ conversationId: '1', version: '${version}' })); })
  .listen(port, '127.0.0.1', () => console.log('Mars Pi agent ready'));
`;
const repo = join(base, 'repo'), host = join(repo, 'packages/pi-host');
await mkdir(host, { recursive: true });
await writeFile(join(host, 'run-checks.mjs'), "import { existsSync } from 'node:fs';\nconst ok = !existsSync(new URL('./broken.flag', import.meta.url));\nconsole.log(JSON.stringify({ ok, total: 1, passed: ok ? ['check-fake.mjs'] : [], failed: ok ? [] : [{ file: 'check-fake.mjs', log: 'flag set' }] }));\nprocess.exit(ok ? 0 : 1);\n");
await writeFile(join(host, 'package.json'), '{"type":"module","scripts":{"check":"node run-checks.mjs"},"dependencies":{}}\n');
await writeFile(join(host, 'server.mjs'), server('v1'));
await writeFile(join(host, 'feature.mjs'), 'export const value = 1;\n');
await writeFile(join(repo, '.gitignore'), 'node_modules\n');
await git(repo, 'init', '-q', '-b', 'main'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'v1');

const root = join(base, 'live'), app = join(root, 'app');
await mkdir(join(app, 'node_modules'), { recursive: true });
// The live app is the v1 commit, as a previous deploy would have left it.
await sh('bash', ['-o', 'pipefail', '-c', 'git -C "$1" archive HEAD packages/pi-host | tar -x -C "$2" --strip-components=2', '_', repo, app]);
const port = await freePort();
const dev = createDevTools({ root, appDir: app, repo, service: 'never.service', livePort: port, systemdRun: '/usr/bin/false', bootTimeoutMs: 15000 });
const selfEdit = createSelfEdit({ repo, root, dir: join(base, 'edits'), dependencies: null, deploy: (args, signal) => dev.deploy(args, signal) });
const tool = (name) => selfEdit.extension.tools.find((t) => t.name === name);
const call = async (name, args) => (await tool(name).execute(args, {}, { abortSignal: new AbortController().signal })).structuredOutput;

try {
  const started = await call('self_edit_start', { title: 'Bump feature' });
  await writeFile(join(started.worktree, 'packages/pi-host/feature.mjs'), 'export const value = 2;\n');
  const finished = await call('self_edit_finish', { id: started.id, deploy: 'dry_run' });
  assert.equal(finished.status, 'dry_run_passed', JSON.stringify(finished));
  assert.ok(finished.deployId, 'the real deploy gate returned a deploy id');
  const plan = JSON.parse(await readFile(join(root, 'deploys', finished.deployId, 'plan.json'), 'utf8'));
  assert.equal(plan.commit, finished.commit, 'the gate staged exactly the self-edit commit');
  assert.deepEqual(plan.changed, ['feature.mjs'], 'and saw exactly the changed file: ' + JSON.stringify({ changed: plan.changed, added: plan.added }));
  assert.equal(plan.boot.ok, true, 'the staged commit booted in isolation');
  assert.equal(await readFile(join(app, 'server.mjs'), 'utf8'), server('v1'), 'the live app is untouched by a dry run');
  assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main', 'the live checkout stays on main');

  // A self-edit whose staged checks fail is reported as staging_failed with a plain next step.
  const second = await call('self_edit_start', { title: 'Break checks' });
  await writeFile(join(second.worktree, 'packages/pi-host/broken.flag'), 'x\n');
  const failed = await call('self_edit_finish', { id: second.id, deploy: 'dry_run' });
  assert.equal(failed.status, 'staging_failed', JSON.stringify(failed));
  assert.match(failed.next, /check-fake\.mjs|fix|Fix/, 'the next step names what to fix');
  // The agent's host_deploy refuses a commit that weakens a gate, even outside self_edit_*.
  await writeFile(join(host, 'run-checks.mjs'), "console.log(JSON.stringify({ ok: true, total: 0, passed: [], failed: [] }));\n");
  await git(repo, 'commit', '-qam', 'weaken the checks');
  const hostDeploy = dev.extension.tools.find((t) => t.name === 'host_deploy');
  const refusedDeploy = (await hostDeploy.execute({ dryRun: true, skipChecks: true }, {}, { abortSignal: new AbortController().signal })).structuredOutput;
  assert.equal(refusedDeploy.status, 'refused', 'host_deploy from the agent refuses a commit that changes run-checks.mjs: ' + JSON.stringify(refusedDeploy).slice(0, 300));
  assert.equal(refusedDeploy.refused[0].path, 'packages/pi-host/run-checks.mjs');
  assert.match(refusedDeploy.next, /only the owner deploys that/);
  // The owner's own deploy path (npm run host:deploy calls deploy() directly) is not limited.
  const owner = await dev.deploy({ dryRun: true });
  assert.equal(owner.status, 'dry_run', 'the owner can still deploy it');
  console.log('PASS self-edit with the real deploy gate: dry run stages the exact self-edit commit, sees the changed file, boots it in isolation and leaves the live app and checkout alone; failing staged checks come back as staging_failed with a next step; the agent host_deploy refuses a commit that changes run-checks.mjs while the owner deploy is not limited');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(base, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
