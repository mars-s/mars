// Self-edit: change Mars host code in a git worktree, check it, commit it and deploy it
// through host_deploy, refusing changes to the files that judge a change. Spec: docs/SELF-EDIT.md.
import { mkdir, mkdtemp, readFile, readdir, rm, lstat, symlink, unlink, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { ROOT, APP, REPO, PORT, DEPENDENCIES, atomicJson } from './security.mjs';
import { createDevTools, sh } from './dev-tools.mjs';

const HOST = 'packages/pi-host/';

// The files that decide whether a self-edit is acceptable. Any change to them is refused.
const PROTECTED = [
  [/^packages\/pi-host\/run-checks\.mjs$/, 'runs the checks and decides pass or fail'],
  [/^packages\/pi-host\/deploy-watchdog\.sh$/, 'applies a deploy and rolls back an unhealthy host'],
  [/^packages\/pi-host\/dev-tools\.mjs$/, 'is the deploy gate (staging, checks and the test boot)'],
  [/^packages\/pi-host\/self-edit\.mjs$/, 'is this guard'],
  [/^packages\/pi-host\/tool-quality\.mjs$/, 'holds the tool-quality rules'],
  [/^packages\/pi-host\/security\.mjs$/, 'holds owner authentication, origins and data roots'],
  [/^packages\/pi-host\/extension-store\.mjs$/, 'decides which extensions and tool names may be installed'],
  [/^packages\/pi-host\/ui-patches\.mjs$/, 'is the UI patch validation gate'],
  [/^packages\/pi-host\/workbench\/test-host\.mjs$/, 'is the test host many checks share'],
  [/^packages\/pi-host\/tsconfig\.json$/, 'holds the names and imports check settings'],
  [/^scripts\/(check-[^/]*|test-[^/]*|run-script-tests)\.mjs$/, 'is a root gate or its test'],
  [/^architecture-policy\.json$/, 'holds the workspace boundary rules'],
  [/^(AGENTS\.md|\.agents\/DECISIONS\.md|\.agents\/verification\.md|docs\/SELF-EDIT\.md)$/, 'holds the rules for changing Mars'],
  [/^(\.gitignore|\.github\/.*)$/, 'decides what may be committed, or runs CI'],
];
const NEVER = [
  [/(^|\/)node_modules(\/|$)/, 'is installed dependencies, never committed'],
  [/(^|\/)\.env(\.[^/]+)?$/, 'may hold secrets, never committed'],
  [/\.(sqlite|db)(-wal|-shm)?$/, 'is a database, never committed'],
];
const EXISTING_CHECK = /^packages\/pi-host\/check-[^/]*\.mjs$/;
// tsc codes for an unknown name, a missing module or export, and a duplicate declaration.
const NAME_ERRORS = new Set(['TS2300', 'TS2304', 'TS2305', 'TS2307', 'TS2393', 'TS2451', 'TS2552', 'TS2614', 'TS2724']);

/** Why each change may not be part of a self-edit. `changes` are git name-status rows. */
export function guardChanges(changes) {
  const refused = [];
  for (const { status, path } of changes) {
    if (path.endsWith('.env.example')) continue;
    const never = NEVER.find(([pattern]) => pattern.test(path));
    const rule = PROTECTED.find(([pattern]) => pattern.test(path));
    if (never) refused.push({ path, reason: path + ' ' + never[1] + '.' });
    else if (rule) refused.push({ path, reason: path + ' ' + rule[1] + '; only the owner changes it.' });
    else if (EXISTING_CHECK.test(path) && status !== 'A') refused.push({ path, reason: path + ' is an existing check; a self-edit may add a check but not change or delete one.' });
  }
  return refused;
}

const slug = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const tail = (text, n = 1200) => (text.length > n ? '...' + text.slice(-n) : text);
const exists = path => stat(path).then(() => true, () => false);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Relative module references of every host file, as host-relative paths. */
async function referenceGraph(hostDir) {
  const graph = new Map();
  async function walk(dir) {
    for (const entry of await readdir(join(hostDir, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(mjs|js)$/.test(entry.name)) {
        const source = await readFile(join(hostDir, path), 'utf8');
        graph.set(path, [...source.matchAll(IMPORT)].map(match => normalize(join(dirname(path), match[1]))).filter(target => !target.startsWith('..')));
      }
    }
  }
  await walk('');
  return graph;
}
function reach(graph, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const next of graph.get(queue.shift()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

/**
 * tsc --checkJs over a host folder, keeping only unknown names, missing modules or exports and
 * duplicate declarations. The full output is mostly typing noise (docs/SELF-EDIT.md).
 */
export async function checkNames(hostDir, dependencies = DEPENDENCIES, signal) {
  const tsc = join(dependencies ?? "", "typescript/bin/tsc");
  if (!dependencies || !(await exists(tsc)) || !(await exists(join(hostDir, "tsconfig.json")))) return { skipped: "TypeScript or packages/pi-host/tsconfig.json is missing, so names and imports were not checked." };
  const run = await sh(process.execPath, [tsc, "-p", "tsconfig.json", "--pretty", "false"], { cwd: hostDir, timeoutMs: 180000, signal });
  const failed = [];
  for (const line of run.stdout.split("\n")) {
    const match = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/);
    if (match && NAME_ERRORS.has(match[3])) failed.push({ step: "names", file: HOST + match[1], detail: "line " + match[2] + ": " + match[4] });
  }
  return { failed };
}

export function createSelfEdit({
  repo = REPO,
  root = ROOT,
  dir = process.env.MARS_SELF_EDIT_DIR || join(root, 'self-edits'),
  dependencies = DEPENDENCIES,
  deploy = (args, signal) => createDevTools({ root, appDir: APP, repo, livePort: PORT }).deploy(args, signal),
} = {}) {
  const records = join(root, 'data/self-edits');
  let chain = Promise.resolve();
  const serial = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
  const git = (cwd, args, options) => sh('git', ['-C', cwd, ...args], options);

  async function load(id) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) throw Error('Invalid self-edit id "' + id + '". Use the id from self_edit_start or self_edit_list.');
    let session;
    try { session = JSON.parse(await readFile(join(records, id + '.json'), 'utf8')); } catch { throw Error('No self-edit with id ' + id + '. Call self_edit_list to see the open ones.'); }
    if (session.state === 'abandoned') throw Error('Self-edit ' + id + ' was abandoned. Start a new one with self_edit_start.');
    return session;
  }
  const save = session => atomicJson(join(records, session.id + '.json'), session);

  async function start({ title }) {
    const name = slug(String(title ?? ''));
    if (!name) throw Error('Give a title with letters or digits, e.g. "Fix plan step trimming".');
    const head = await git(repo, ['rev-parse', 'HEAD']);
    if (head.code !== 0) throw Error('The Mars checkout at ' + repo + ' is not a git repository: ' + head.stderr.trim());
    const base = head.stdout.trim();
    const id = name + '-' + randomBytes(2).toString('hex');
    const worktree = join(dir, id), branch = 'self-edit/' + id;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const added = await git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, base]);
    if (added.code !== 0) throw Error('Could not create the worktree: ' + added.stderr.trim());
    if (dependencies && (await exists(dependencies))) await symlink(dependencies, join(worktree, 'node_modules'));
    const session = { id, title: String(title).trim(), branch, worktree, base, repo, state: 'open', createdAt: new Date().toISOString() };
    await save(session);
    return {
      id, worktree, branch, base,
      next: `Edit files inside ${worktree} only (host code is in ${HOST}), e.g. apply_patch with cwd "${worktree}". The live checkout is untouched. Then call self_edit_check with id "${id}".`,
    };
  }

  /** Stage everything in the worktree and list what differs from the base commit. */
  async function changes(session) {
    const add = await git(session.worktree, ['add', '-A']);
    if (add.code !== 0) throw Error('git add failed in ' + session.worktree + ': ' + add.stderr.trim());
    // The dependency link is not matched by a node_modules/ ignore rule, so unstage it explicitly.
    await git(session.worktree, ['rm', '-q', '--cached', '--ignore-unmatch', 'node_modules']);
    const diff = await git(session.worktree, ['diff', '--cached', '--name-status', '--no-renames', '-z', session.base]);
    if (diff.code !== 0) throw Error('git diff failed: ' + diff.stderr.trim());
    const parts = diff.stdout.split('\0').filter(Boolean);
    const rows = [];
    for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i][0], path: parts[i + 1] });
    return rows;
  }

  async function runChecks(session, rows, scope, signal) {
    const hostDir = join(session.worktree, HOST);
    const graph = await referenceGraph(hostDir);
    const checkFiles = [...graph.keys()].filter(path => /^check-[^/]*\.mjs$/.test(path)).sort();
    const changedHost = rows.map(row => row.path).filter(path => path.startsWith(HOST)).map(path => path.slice(HOST.length));
    const closures = new Map(checkFiles.map(file => [file, reach(graph, file)]));
    const reached = path => checkFiles.filter(file => closures.get(file).has(path));
    const untested = changedHost.filter(path => /\.(mjs|js)$/.test(path) && !path.startsWith('check-') && !reached(path).length).map(path => HOST + path);
    const everything = scope === 'all' || rows.some(row => /(^|\/)package(-lock)?\.json$/.test(row.path)) || changedHost.some(path => !/\.(mjs|js)$/.test(path) && !reached(path).length);
    const selected = everything ? checkFiles : checkFiles.filter(file => changedHost.includes(file) || changedHost.some(path => closures.get(file).has(path)));
    if (!selected.length) return { ran: [], failed: [], untested };
    const temp = await mkdtemp(join(tmpdir(), 'mars-self-edit-check-'));
    try {
      const run = await sh(process.execPath, ['run-checks.mjs', '--json', ...(everything ? [] : selected)], {
        cwd: hostDir, timeoutMs: 900000, signal,
        env: { MARS_PI_ROOT: temp, MARS_REPO_ROOT: session.worktree, MARS_UI_DIR: join(session.worktree, 'apps/ui'), MARS_PUBLIC_ORIGIN: '', MARS_ALLOWED_ORIGINS: '', MARS_DUMP_TOOLS: '' },
      });
      let summary;
      try { summary = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch {}
      if (!summary) return { ran: [], failed: [{ step: 'check', file: HOST + 'run-checks.mjs', detail: tail(run.stdout + run.stderr) }], untested };
      return {
        ran: [...summary.passed, ...summary.failed.map(row => row.file)].sort(),
        failed: summary.failed.map(row => ({ step: 'check', file: HOST + row.file, detail: tail(row.log) })),
        untested,
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  /** Guard, syntax, names and imports, then the related host checks. Stops at the first failing step. */
  async function inspect(session, scope, signal) {
    const rows = await changes(session);
    const changed = rows.map(row => row.path);
    const notDeployed = changed.filter(path => !path.startsWith(HOST));
    const result = { id: session.id, ok: false, changed, refused: [], failed: [], ran: [], untested: [], notDeployed, notes: [] };
    result.refused = guardChanges(rows);
    if (result.refused.length) return result;
    const present = rows.filter(row => row.status !== 'D');
    for (const { path } of present) {
      const file = join(session.worktree, path);
      if (/\.(mjs|js|cjs)$/.test(path)) {
        const check = await sh(process.execPath, ['--check', file], { signal });
        if (check.code !== 0) result.failed.push({ step: 'syntax', file: path, detail: tail(check.stderr) });
      } else if (path.endsWith('.json')) {
        try { JSON.parse(await readFile(file, 'utf8')); } catch (error) { result.failed.push({ step: 'syntax', file: path, detail: error.message }); }
      }
    }
    if (result.failed.length) return result;
    const hostDir = join(session.worktree, HOST);
    if (changed.some(path => path.startsWith(HOST))) {
      const typed = await checkNames(hostDir, dependencies, signal);
      if (typed.skipped) result.notes.push(typed.skipped);
      else if (typed.failed.length) { result.failed = typed.failed; return result; }
      Object.assign(result, await runChecks(session, rows, scope, signal));
      // Code under test runs during the checks, so look again for a protected file it changed.
      result.refused = guardChanges(await changes(session));
    }
    result.ok = !result.refused.length && !result.failed.length;
    return result;
  }

  function nextAfterInspect(session, result) {
    if (result.refused.length) {
      const first = result.refused[0];
      return `Refused: ${first.reason} Undo it with: git -C ${session.worktree} checkout ${session.base} -- ${first.path} (or delete the file if you added it). Then call self_edit_check again.`;
    }
    if (result.failed.length) {
      const first = result.failed[0];
      const what = first.step === 'check' ? `The check ${first.file} failed. Read failed[0].detail and fix the code, not the check.` : `${first.file} has a ${first.step === 'names' ? 'wrong name or import' : 'syntax error'}: ${first.detail.split('\n')[0]}`;
      return `${what} Then call self_edit_check with id "${session.id}" again.`;
    }
    return '';
  }

  async function check({ id, scope = 'related' }, signal) {
    const session = await load(id);
    const result = await inspect(session, scope, signal);
    let next = nextAfterInspect(session, result);
    if (!next && !result.changed.length) next = `Nothing has changed yet. Edit files in ${session.worktree}, then call self_edit_check again.`;
    if (!next) {
      next = `Checks passed. Call self_edit_finish with id "${id}" to commit it and test it with a dry-run deploy.`;
      if (result.untested.length) next += ` No check covers ${result.untested.join(', ')}; add a new check-*.mjs for it, or run self_edit_check with scope "all".`;
      if (result.notDeployed.length) next += ` ${result.notDeployed.join(', ')} ${result.notDeployed.length === 1 ? 'is' : 'are'} outside ${HOST} and host_deploy does not ship ${result.notDeployed.length === 1 ? 'it' : 'them'}.`;
    }
    return { ...result, next };
  }

  async function finish({ id, deploy: mode = 'dry_run', message }, signal) {
    const session = await load(id);
    const result = await inspect(session, 'related', signal);
    const report = { id, status: '', commit: null, deployId: null, refused: result.refused, failed: result.failed, notDeployed: result.notDeployed };
    if (result.refused.length) return { ...report, status: 'refused', next: nextAfterInspect(session, result) };
    if (result.failed.length) return { ...report, status: 'check_failed', next: nextAfterInspect(session, result) };
    const staged = await git(session.worktree, ['diff', '--cached', '--quiet']);
    if (staged.code !== 0) {
      const identity = (await git(session.worktree, ['config', 'user.email'])).code === 0 ? [] : ['-c', 'user.name=Mars agent', '-c', 'user.email=mars-agent@localhost'];
      const commit = await sh('git', [...identity, '-C', session.worktree, 'commit', '-q', '--no-verify', '-m', String(message || session.title)], { signal });
      if (commit.code !== 0) throw Error('git commit failed: ' + tail(commit.stderr + commit.stdout, 600));
    }
    const commit = (await git(session.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    report.commit = commit;
    if (commit === session.base) return { ...report, status: 'nothing_to_finish', next: `Nothing has changed from the base commit. Edit files in ${session.worktree}, or call self_edit_abandon with id "${id}".` };
    session.commit = commit;
    session.state = 'committed';
    await save(session);
    if (mode === 'none') return { ...report, status: 'committed', next: `Committed ${commit.slice(0, 12)} on branch ${session.branch}. To test it, call self_edit_finish with id "${id}" and deploy "dry_run".` };
    if (mode === 'deploy') {
      if (session.deployed?.commit === commit) return { ...report, status: 'scheduled', deployId: session.deployed.id, next: `This commit was already deployed. Call host_deploy_status with id "${session.deployed.id}".` };
      if (session.dryRun?.commit !== commit || !session.dryRun.ok) return { ...report, status: 'dry_run_required', next: `Run a dry run of this exact commit first: call self_edit_finish with id "${id}" and deploy "dry_run".` };
    }
    let outcome;
    try {
      outcome = await deploy({ ref: commit, ...(mode === 'dry_run' ? { dryRun: true } : {}) }, signal);
    } catch (error) {
      return { ...report, status: 'deploy_error', next: `host_deploy could not run: ${String(error.message || error).slice(0, 400)} Fix that, then call self_edit_finish again.` };
    }
    report.deployId = outcome.id ?? null;
    report.deploy = { status: outcome.status, ok: outcome.ok, checks: outcome.checks && { ok: outcome.checks.ok, failed: (outcome.checks.failed ?? []).map(row => row.file) }, boot: outcome.boot && { ok: outcome.boot.ok, error: outcome.boot.error } };
    if (outcome.status === 'staging_failed' || outcome.ok === false) {
      report.failed = (outcome.checks?.failed ?? []).map(row => ({ step: 'staging', file: HOST + row.file, detail: tail(row.log ?? '') }));
      if (outcome.boot && outcome.boot.ok === false) report.failed.push({ step: 'staging', file: HOST + 'server.mjs', detail: tail(String(outcome.boot.error ?? '') + '\n' + (outcome.boot.log ?? '')) });
      if (mode === 'dry_run') { session.dryRun = { commit, id: outcome.id, ok: false }; await save(session); }
      const where = report.failed.map(row => row.file).join(', ') || 'staging';
      return { ...report, status: 'staging_failed', next: `The staged copy failed in ${where}; the live host is untouched. Fix it in ${session.worktree}, run self_edit_check with id "${id}" and scope "all", then self_edit_finish again.` };
    }
    if (mode === 'dry_run') {
      session.dryRun = { commit, id: outcome.id, ok: true };
      await save(session);
      return { ...report, status: 'dry_run_passed', next: `The dry run passed and nothing was restarted. To ship it, call self_edit_finish with id "${id}" and deploy "deploy"; the host restarts and rolls back by itself if unhealthy.` };
    }
    session.deployed = { commit, id: outcome.id };
    session.state = 'deployed';
    await save(session);
    const merge = `Once it says deployed, merge branch ${session.branch} into the checkout (git -C ${session.repo} merge ${session.branch}) or ask the owner to, or the next deploy from main undoes it.`;
    if (outcome.status === 'noop') return { ...report, status: 'noop', next: `The live host already runs this code. ${merge}` };
    return { ...report, status: 'scheduled', next: `The host restarts shortly and interrupts this call. Afterwards call host_deploy_status with id "${outcome.id}". ${merge}` };
  }

  async function abandon({ id }) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) throw Error('Invalid self-edit id "' + id + '". Use the id from self_edit_list.');
    let session;
    try { session = JSON.parse(await readFile(join(records, id + '.json'), 'utf8')); } catch { throw Error('No self-edit with id ' + id + '. Call self_edit_list to see the open ones.'); }
    if (session.state === 'abandoned') return { id, abandoned: true, next: 'Already abandoned. Nothing else to do.' };
    const link = join(session.worktree, 'node_modules');
    if ((await lstat(link).catch(() => null))?.isSymbolicLink()) await unlink(link);
    const removed = await git(session.repo, ['worktree', 'remove', '--force', session.worktree]);
    if (removed.code !== 0 && (await exists(session.worktree))) throw Error('Could not remove the worktree: ' + removed.stderr.trim());
    await git(session.repo, ['worktree', 'prune']);
    if (!session.deployed) await git(session.repo, ['branch', '-D', session.branch]);
    session.state = 'abandoned';
    await save(session);
    return { id, abandoned: true, next: session.deployed ? `Removed the worktree. Branch ${session.branch} is kept because the live host runs it.` : 'Removed the worktree and its branch. Nothing else to do.' };
  }

  async function list() {
    const names = (await readdir(records).catch(() => [])).filter(name => name.endsWith('.json')).sort();
    const sessions = [];
    for (const name of names) {
      try {
        const { id, title, state, branch, worktree, commit = null } = JSON.parse(await readFile(join(records, name), 'utf8'));
        if (state !== 'abandoned') sessions.push({ id, title, state, branch, worktree, commit });
      } catch {}
    }
    return { sessions, next: sessions.length ? 'Pass an id to self_edit_check, self_edit_finish or self_edit_abandon.' : 'No open self-edits. Start one with self_edit_start.' };
  }

  const output = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
  const Problem = Type.Object({
    step: Type.String({ description: 'Where it failed: "syntax", "names", "check" or "staging".' }),
    file: Type.String({ description: 'The file to fix, from the repository root.' }),
    detail: Type.String({ description: 'The error, or the end of the failing check output.' }),
  });
  const Refusal = Type.Object({
    path: Type.String({ description: 'The protected file that changed.' }),
    reason: Type.String({ description: 'Why a self-edit may not change it.' }),
  });
  const id = Type.String({ description: 'Self-edit id from self_edit_start, e.g. "fix-plan-trim-3f2a".' });
  const next = Type.String({ description: 'What to do next, in plain words.' });
  const extension = defineExtension({
    name: 'self-edit',
    marsPlugin: { title: 'Self Edit', version: '1.0.0', description: 'Change Mars host code in a separate git worktree, check it, then commit and deploy it through host_deploy. Changes to the checks, the deploy gate and the rules are refused.' },
    tools: [
      defineTool({
        name: 'self_edit_start',
        description: `Start a change to Mars itself in a separate copy of the code, leaving the live checkout untouched.
Use it first whenever you change Mars host code (packages/pi-host). It makes a git worktree and branch from the current commit. Edit files only inside the returned worktree, then call self_edit_check. For interface-only changes, ui_patch_stage is simpler.
Example: await tools.self_edit_start({ title: "Trim plan steps" })`,
        parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120, description: 'Short name for the change, e.g. "Trim plan steps". Also the default commit message.' }) }),
        replay: 'unsafe', executionMode: 'sequential', deferred: true,
        structuredOutputSchema: Type.Object({
          id: Type.String({ description: 'Pass it to self_edit_check, self_edit_finish and self_edit_abandon.' }),
          worktree: Type.String({ description: 'Absolute folder to edit in. Host code is in its packages/pi-host.' }),
          branch: Type.String({ description: 'The git branch of this change.' }),
          base: Type.String({ description: 'The commit this change starts from.' }),
          next,
        }),
        execute: async args => output(await serial(() => start(args))),
      }),
      defineTool({
        name: 'self_edit_check',
        description: `Check a self-edit: protected files, syntax, names and imports, and the host checks that cover the changed files.
Use it after editing files in the self-edit worktree, and again after each fix. It changes nothing outside the worktree. Changes to the checks, the deploy gate or the rules are refused. When ok is true, call self_edit_finish; otherwise fix what failed[0] names and check again. scope "all" runs every host check (slower).
Example: await tools.self_edit_check({ id: "trim-plan-steps-3f2a" })`,
        parameters: Type.Object({
          id,
          scope: Type.Optional(Type.Union([Type.Literal('related'), Type.Literal('all')], { default: 'related', description: '"related" runs the checks that cover the changed files; "all" runs every host check.' })),
        }),
        replay: 'safe', executionMode: 'sequential', deferred: true, outputLimits: { maxBytes: 20000, maxLines: 300 },
        structuredOutputSchema: Type.Object({
          id: Type.String({ description: 'The self-edit checked.' }),
          ok: Type.Boolean({ description: 'True when nothing was refused or failed.' }),
          changed: Type.Array(Type.String(), { description: 'Files that differ from the base commit.' }),
          refused: Type.Array(Refusal, { description: 'Protected files you changed. Undo these first.' }),
          failed: Type.Array(Problem, { description: 'What failed, first problem first.' }),
          ran: Type.Array(Type.String(), { description: 'Host check files that ran.' }),
          untested: Type.Array(Type.String(), { description: 'Changed host files no check covers.' }),
          notDeployed: Type.Array(Type.String(), { description: 'Changed files outside packages/pi-host, which host_deploy does not ship.' }),
          notes: Type.Array(Type.String(), { description: 'Steps that were skipped, and why.' }),
          next,
        }),
        execute: async (args, _api, context) => output(await serial(() => check(args, context?.abortSignal))),
      }),
      defineTool({
        name: 'self_edit_finish',
        description: `Commit a checked self-edit and test it with host_deploy, as a dry run or a real deploy.
Use it when self_edit_check passes. It checks again, commits on the self-edit branch, then runs host_deploy for that exact commit. deploy "dry_run" (default) stages and boots it without restarting. deploy "deploy" restarts the host with automatic rollback, and is allowed only after a passed dry run of the same commit. deploy "none" only commits. Read status and next.
Example: await tools.self_edit_finish({ id: "trim-plan-steps-3f2a", deploy: "dry_run" })`,
        parameters: Type.Object({
          id,
          deploy: Type.Optional(Type.Union([Type.Literal('dry_run'), Type.Literal('deploy'), Type.Literal('none')], { default: 'dry_run', description: '"dry_run" tests without restarting, "deploy" ships it after a passed dry run, "none" only commits.' })),
          message: Type.Optional(Type.String({ maxLength: 200, description: 'Commit message. Default: the title given to self_edit_start.' })),
        }),
        replay: 'unsafe', executionMode: 'sequential', deferred: true, outputLimits: { maxBytes: 20000, maxLines: 300 },
        structuredOutputSchema: Type.Object({
          id: Type.String({ description: 'The self-edit.' }),
          status: Type.String({ description: 'refused, check_failed, nothing_to_finish, committed, dry_run_passed, dry_run_required, staging_failed, deploy_error, scheduled or noop.' }),
          commit: Type.Union([Type.String(), Type.Null()], { description: 'The commit made or reused, or null.' }),
          deployId: Type.Union([Type.String(), Type.Null()], { description: 'host_deploy id; pass it to host_deploy_status.' }),
          refused: Type.Array(Refusal, { description: 'Protected files you changed. Nothing was committed.' }),
          failed: Type.Array(Problem, { description: 'What failed, first problem first.' }),
          notDeployed: Type.Array(Type.String(), { description: 'Changed files outside packages/pi-host, which host_deploy does not ship.' }),
          next,
        }, { additionalProperties: true }),
        execute: async (args, _api, context) => output(await serial(() => finish(args, context?.abortSignal))),
      }),
      defineTool({
        name: 'self_edit_abandon',
        description: `Throw away a self-edit: remove its worktree and branch.
Use it when a change is not worth finishing, or after a dry run you do not want to ship. The live checkout and live host are not touched. After a real deploy the branch is kept, because the live host runs it. Calling it again does nothing.
Example: await tools.self_edit_abandon({ id: "trim-plan-steps-3f2a" })`,
        parameters: Type.Object({ id }),
        replay: 'unsafe', executionMode: 'sequential', deferred: true,
        structuredOutputSchema: Type.Object({
          id: Type.String({ description: 'The self-edit removed.' }),
          abandoned: Type.Boolean({ description: 'True once the worktree is gone.' }),
          next,
        }),
        execute: async args => output(await serial(() => abandon(args))),
      }),
      defineTool({
        name: 'self_edit_list',
        description: `List the self-edits that are still open, with their worktree and state.
Use it to find the id of a change you started earlier, for example after a restart. Abandoned ones are not shown.
Example: await tools.self_edit_list({})`,
        parameters: Type.Object({}),
        replay: 'safe', deferred: true,
        structuredOutputSchema: Type.Object({
          sessions: Type.Array(Type.Object({
            id: Type.String({ description: 'Self-edit id.' }),
            title: Type.String({ description: 'The title it was started with.' }),
            state: Type.String({ description: 'open, committed or deployed.' }),
            branch: Type.String({ description: 'Its git branch.' }),
            worktree: Type.String({ description: 'Folder to edit in.' }),
            commit: Type.Union([Type.String(), Type.Null()], { description: 'Last commit made by self_edit_finish, or null.' }),
          }), { description: 'Open self-edits, oldest first.' }),
          next,
        }),
        execute: async () => output(await list()),
      }),
    ],
  });
  return { extension, start, check, finish, abandon, list };
}

// node self-edit.mjs names: the names and imports check on this host folder.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "names") {
  const result = await checkNames(APP);
  if (result.skipped) console.log(result.skipped);
  else for (const problem of result.failed) console.error(problem.file + " " + problem.detail);
  console.log(result.skipped ? "" : result.failed.length ? result.failed.length + " name or import errors" : "PASS names and imports");
  process.exitCode = result.failed?.length ? 1 : 0;
}
