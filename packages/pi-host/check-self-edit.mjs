// Self-edit tools (docs/SELF-EDIT.md) against a fixture Mars checkout, with an injected deploy.
// No service is restarted, no model is called and the live data root is never used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rename, rm, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { createDevTools, sh } from './dev-tools.mjs';
import { DEPENDENCIES } from './security.mjs';
import { createSelfEdit, guardChanges } from './self-edit.mjs';

const base = await mkdtemp(join(tmpdir(), 'mars-self-edit-'));
const exists = path => stat(path).then(() => true, () => false);
const git = (cwd, ...args) => sh('git', ['-c', 'user.name=check', '-c', 'user.email=check@local', '-C', cwd, ...args]);
const markers = join(base, 'markers');
process.env.SELF_EDIT_MARKERS = markers;

const repo = join(base, 'checkout'), host = join(repo, 'packages/pi-host');
await mkdir(host, { recursive: true });
await mkdir(markers);
await copyFile(new URL('./run-checks.mjs', import.meta.url), join(host, 'run-checks.mjs'));
await copyFile(new URL('./tsconfig.json', import.meta.url), join(host, 'tsconfig.json'));
const marker = name => `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.SELF_EDIT_MARKERS + '/${name}', 'ran\\n');\n`;
await writeFile(join(host, 'a.mjs'), 'export const answer = 42;\n');
await writeFile(join(host, 'b.mjs'), 'export const other = 1;\n');
await writeFile(join(host, 'check-a.mjs'), marker('check-a') + "import assert from 'node:assert/strict'; import { answer } from './a.mjs';\nassert.equal(answer, 42, 'answer is 42');\n");
await writeFile(join(host, 'check-b.mjs'), marker('check-b') + "import { other } from './b.mjs'; if (other !== 1) process.exit(1);\n");
await writeFile(join(host, 'package.json'), '{"type":"module","scripts":{"check":"node run-checks.mjs"}}\n');
await writeFile(join(repo, '.gitignore'), 'node_modules\n');
await git(repo, 'init', '-q', '-b', 'main'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');

const liveState = async () => ({
  head: (await git(repo, 'rev-parse', 'HEAD')).stdout.trim(),
  branch: (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(),
  status: (await git(repo, 'status', '--porcelain')).stdout,
  a: await readFile(join(host, 'a.mjs'), 'utf8'),
  runChecks: await readFile(join(host, 'run-checks.mjs'), 'utf8'),
});
const before = await liveState();

const deploys = [];
let deployResult = args => ({ id: 'deploy-' + (deploys.length - 1), status: args.dryRun ? 'dry_run' : 'scheduled', ok: true, checks: { ok: true, failed: [] }, boot: { ok: true } });
const selfEdit = createSelfEdit({
  repo, root: join(base, 'data-root'), dir: join(base, 'edits'), dependencies: DEPENDENCIES,
  deploy: async args => { deploys.push(args); return deployResult(args); },
});
const tools = Object.fromEntries(selfEdit.extension.tools.map(tool => [tool.name, tool]));
// Through the real tool definitions, validating each result against its declared schema.
const call = async (name, args) => {
  const tool = tools[name];
  assert.ok(Compile(tool.parameters).Check(args), name + ' accepts ' + JSON.stringify(args));
  const value = (await tool.execute(args, {}, { abortSignal: new AbortController().signal })).structuredOutput;
  assert.ok(Compile(tool.structuredOutputSchema).Check(value), name + ' result matches its schema: ' + JSON.stringify(value).slice(0, 400));
  assert.equal(typeof value.next, 'string', name + ' says what to do next');
  assert.ok(value.next.length > 10);
  return value;
};
const ranChecks = async () => (await readdir(markers)).sort();
const clearMarkers = async () => { for (const name of await readdir(markers)) await rm(join(markers, name)); };

try {
  // Start: a worktree and branch, the live checkout untouched.
  const started = await call('self_edit_start', { title: 'Change the answer' });
  assert.match(started.id, /^change-the-answer-[0-9a-f]{4}$/);
  assert.equal(started.worktree, join(base, 'edits', started.id));
  assert.equal(started.branch, 'self-edit/' + started.id);
  assert.equal(started.base, before.head);
  assert.match(started.next, /self_edit_check/);
  const wt = started.worktree, wtHost = join(wt, 'packages/pi-host');
  assert.equal(await readFile(join(wtHost, 'a.mjs'), 'utf8'), before.a);
  assert.deepEqual(await liveState(), before, 'start leaves the live checkout unchanged');
  const id = started.id;
  await assert.rejects(call('self_edit_start', { title: '!!!' }), /letters or digits/);

  // A failing related check is reported by file with a next action; the unrelated check does not run.
  await writeFile(join(wtHost, 'a.mjs'), 'export const answer = 41;\n');
  let checked = await call('self_edit_check', { id });
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.changed, ['packages/pi-host/a.mjs']);
  assert.equal(checked.failed[0].step, 'check');
  assert.equal(checked.failed[0].file, 'packages/pi-host/check-a.mjs');
  assert.match(checked.failed[0].detail, /answer is 42/);
  assert.match(checked.next, /check-a\.mjs failed/);
  assert.match(checked.next, /self_edit_check/);
  assert.deepEqual(checked.ran, ['check-a.mjs']);
  assert.deepEqual(await ranChecks(), ['check-a'], 'only the check that imports a.mjs ran');
  assert.equal((await call('self_edit_finish', { id })).status, 'check_failed');
  assert.equal(deploys.length, 0, 'a failing check never reaches deploy');
  assert.equal((await git(repo, 'rev-parse', started.branch)).stdout.trim(), before.head, 'nothing committed after a failed check');
  assert.deepEqual(await liveState(), before, 'the live checkout keeps its own a.mjs');

  // Syntax and names fail before any check runs.
  await clearMarkers();
  await writeFile(join(wtHost, 'a.mjs'), 'export const answer = ;\n');
  checked = await call('self_edit_check', { id });
  assert.equal(checked.failed[0].step, 'syntax');
  assert.equal(checked.failed[0].file, 'packages/pi-host/a.mjs');
  await writeFile(join(wtHost, 'a.mjs'), "import { missing } from './b.mjs';\nexport const answer = 42 + missng;\n");
  checked = await call('self_edit_check', { id });
  // Staging installs only host dependencies, without TypeScript; then the step must say it was skipped.
  if (await exists(join(DEPENDENCIES, 'typescript/bin/tsc'))) {
    assert.equal(checked.failed[0].step, 'names');
    assert.deepEqual(checked.failed.map(row => row.detail.match(/'(\w+)'/)?.[1]).sort(), ['missing', 'missng']);
    assert.match(checked.next, /wrong name or import/);
  } else assert.match(checked.notes.join(' '), /names and imports were not checked/);
  await clearMarkers();
  assert.deepEqual(await ranChecks(), [], 'no check runs while syntax or names fail');

  // Trust boundary: changes to the files that judge a change are refused and never committed.
  await writeFile(join(wtHost, 'a.mjs'), 'export const answer = 41;\n');
  await writeFile(join(wtHost, 'run-checks.mjs'), "console.log(JSON.stringify({ ok: true, total: 1, passed: ['check-a.mjs'], failed: [] }));\n");
  checked = await call('self_edit_check', { id });
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.refused.map(row => row.path), ['packages/pi-host/run-checks.mjs']);
  assert.match(checked.next, new RegExp('checkout ' + before.head + ' -- packages/pi-host/run-checks\\.mjs'));
  let finished = await call('self_edit_finish', { id, deploy: 'deploy' });
  assert.equal(finished.status, 'refused');
  assert.equal(finished.commit, null);
  assert.equal(deploys.length, 0, 'a refused change never reaches deploy');
  assert.equal((await git(repo, 'rev-parse', started.branch)).stdout.trim(), before.head, 'nothing committed after a refusal');
  await git(wt, 'checkout', before.head, '--', 'packages/pi-host/run-checks.mjs');

  // Editing an existing check, a rename of a protected file and a committed .env are refused too.
  await writeFile(join(wtHost, 'check-a.mjs'), 'process.exit(0);\n');
  assert.deepEqual((await call('self_edit_check', { id })).refused.map(row => row.path), ['packages/pi-host/check-a.mjs']);
  await git(wt, 'checkout', before.head, '--', 'packages/pi-host/check-a.mjs');
  await rename(join(wtHost, 'tsconfig.json'), join(wtHost, 'tsconfig.old.json'));
  await writeFile(join(wt, '.env'), 'TOKEN=fixture\n');
  assert.deepEqual((await call('self_edit_check', { id })).refused.map(row => row.path).sort(), ['.env', 'packages/pi-host/tsconfig.json']);
  await rm(join(wt, '.env'));
  await rename(join(wtHost, 'tsconfig.old.json'), join(wtHost, 'tsconfig.json'));
  // A commit made inside the worktree is judged against the recorded base, not the branch head.
  await writeFile(join(wtHost, 'deploy-watchdog.sh'), 'exit 0\n');
  await git(wt, 'add', 'packages/pi-host/deploy-watchdog.sh'); await git(wt, 'commit', '-qm', 'sneak');
  assert.equal((await call('self_edit_finish', { id })).status, 'refused');
  await git(wt, 'reset', '-q', before.head, '--', '.'); await rm(join(wtHost, 'deploy-watchdog.sh'));
  await git(wt, 'reset', '-q', '--soft', before.head);
  assert.deepEqual(guardChanges([{ status: 'A', path: 'packages/pi-host/check-new.mjs' }, { status: 'M', path: '.env.example' }]), [], 'new checks and .env.example are allowed');

  // A passing change: a new check is allowed and runs, a real deploy needs a dry run first.
  await clearMarkers();
  await writeFile(join(wtHost, 'a.mjs'), 'export const answer = 42;\nexport const double = 84;\n');
  await writeFile(join(wtHost, 'check-double.mjs'), marker('check-double') + "import { double } from './a.mjs'; if (double !== 84) process.exit(1);\n");
  checked = await call('self_edit_check', { id });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.ran, ['check-a.mjs', 'check-double.mjs']);
  assert.deepEqual(await ranChecks(), ['check-a', 'check-double']);
  assert.match(checked.next, /self_edit_finish/);
  finished = await call('self_edit_finish', { id, deploy: 'deploy' });
  assert.equal(finished.status, 'dry_run_required');
  assert.equal(deploys.length, 0, 'no real deploy before a passed dry run');
  const commit = finished.commit;
  assert.equal((await git(repo, 'rev-parse', started.branch)).stdout.trim(), commit, 'the commit is on the self-edit branch');
  assert.deepEqual((await git(repo, 'show', '--name-only', '--format=', commit)).stdout.trim().split('\n').sort(), ['packages/pi-host/a.mjs', 'packages/pi-host/check-double.mjs'], 'node_modules is never committed');

  finished = await call('self_edit_finish', { id });
  assert.equal(finished.status, 'dry_run_passed');
  assert.equal(finished.commit, commit, 'finishing again reuses the commit');
  assert.deepEqual(deploys, [{ ref: commit, dryRun: true }], 'the dry run deploys the exact commit');
  assert.match(finished.next, /deploy "deploy"/);
  finished = await call('self_edit_finish', { id, deploy: 'deploy' });
  assert.equal(finished.status, 'scheduled');
  assert.deepEqual(deploys.at(-1), { ref: commit }, 'the real deploy goes through host_deploy for the same commit');
  assert.match(finished.next, /host_deploy_status with id "deploy-1"/);
  assert.match(finished.next, new RegExp('merge ' + started.branch));
  assert.deepEqual(await liveState(), before, 'finishing leaves the live checkout unchanged');

  // A failed staging run is reported with the failing check and leaves the dry run unpassed.
  const second = await call('self_edit_start', { title: 'Second change' });
  await writeFile(join(second.worktree, 'packages/pi-host/b.mjs'), 'export const other = 1;\nexport const more = 2;\n');
  deployResult = () => ({ id: 'deploy-failed', status: 'staging_failed', ok: false, checks: { ok: false, failed: [{ file: 'check-b.mjs', log: 'AssertionError: boom' }] }, boot: { skipped: true } });
  finished = await call('self_edit_finish', { id: second.id });
  assert.equal(finished.status, 'staging_failed');
  assert.deepEqual(finished.failed.map(row => row.file), ['packages/pi-host/check-b.mjs']);
  assert.match(finished.next, /live host is untouched/);
  assert.equal((await call('self_edit_finish', { id: second.id, deploy: 'deploy' })).status, 'dry_run_required');

  // Abandon removes the worktree and branch, is idempotent, and closes the session.
  assert.deepEqual((await call('self_edit_list', {})).sessions.map(row => row.id).sort(), [id, second.id].sort());
  let abandoned = await call('self_edit_abandon', { id: second.id });
  assert.equal(abandoned.abandoned, true);
  assert.equal(await exists(second.worktree), false, 'worktree removed');
  assert.equal((await git(repo, 'rev-parse', '--verify', '--quiet', second.branch)).code, 1, 'branch deleted');
  assert.doesNotMatch((await git(repo, 'worktree', 'list')).stdout, new RegExp(second.id));
  assert.equal((await call('self_edit_abandon', { id: second.id })).abandoned, true);
  await assert.rejects(call('self_edit_check', { id: second.id }), /abandoned/);
  abandoned = await call('self_edit_abandon', { id });
  assert.match(abandoned.next, /kept because the live host runs it/);
  assert.equal((await git(repo, 'rev-parse', started.branch)).stdout.trim(), commit, 'a deployed branch is kept');
  assert.deepEqual((await call('self_edit_list', {})).sessions, []);
  assert.deepEqual(await liveState(), before, 'the live checkout is unchanged after the whole run');

  // apply_patch resolves a relative cwd against the workspace, as host_exec does, not the host process folder.
  const work = join(base, "workspace");
  await mkdir(join(work, "projects/site"), { recursive: true });
  await writeFile(join(work, "projects/site/README.md"), "Old\n");
  const applyPatch = createDevTools({ root: join(base, "data-root"), repo, work }).extension.tools.find(tool => tool.name === "apply_patch");
  const patched = (await applyPatch.execute({ cwd: "projects/site", patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Old\n+New\n" }, {}, {})).structuredOutput;
  assert.equal(await readFile(join(work, "projects/site/README.md"), "utf8"), "New\n");
  assert.equal(patched.cwd, await realpath(join(work, "projects/site")));
  await assert.rejects(applyPatch.execute({ cwd: "projects/missing", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" }, {}, {}), /Folder not found: .*projects\/missing/);
  console.log('PASS self-edit: worktree isolation, protected-file refusal, related checks with next actions, dry run before deploy, abandon cleanup');
} finally {
  await rm(base, { recursive: true, force: true });
}
