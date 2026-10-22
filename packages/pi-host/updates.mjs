// Updates from main (docs/UPDATES.md): the background check, the owner routes and the
// agent tools. The updater itself is scripts/update.mjs in the checkout; the host runs
// `apply` as its own systemd --user unit, because the update stops this process.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

const output = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const run = (file, args, env) => new Promise((resolve) => {
  const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (data) => { text += data; });
  child.stderr.on('data', (data) => { text += data; });
  child.on('error', (error) => resolve({ code: -1, text: text + error.message }));
  child.on('close', (code) => resolve({ code: code ?? 1, text }));
});

/**
 * `repo` is the checkout (MARS_REPO_ROOT), `root` the private data root. `busy()` says
 * whether a conversation is running, for automatic installs. `systemdRun` and `load`
 * are replaced in checks.
 */
export function createUpdates({ repo, root, env = process.env, busy = async () => false, systemdRun = 'systemd-run', load, log = console.error, managed: isManaged }) {
  const staging = env.MARS_PI_STAGING === '1';
  const managed = isManaged ?? (async () => process.platform === 'linux' && (await run('systemctl', ['--user', 'cat', env.MARS_HOST_SERVICE || 'mars-pi-host.service'])).code === 0);
  let updaterPromise;
  // Loaded from the checkout so the host always runs the checkout's updater, not a copy.
  const updater = () => (updaterPromise ??= (load ? load() : (async () => {
    const [{ createUpdater }, { configuration }] = await Promise.all([
      import(pathToFileURL(join(repo, 'scripts/update.mjs')).href),
      import(pathToFileURL(join(repo, 'scripts/setup.mjs')).href),
    ]);
    return createUpdater({ ...configuration(env, repo), root });
  })()));
  let checking = null;
  let timer = null;

  async function status() { return (await updater()).read(); }
  async function check() {
    checking ??= (async () => { try { return (await (await updater()).check()).status; } finally { checking = null; } })();
    return checking;
  }

  /** Start `npm run update -- apply` as its own unit so stopping the host does not stop it. */
  async function apply({ full = false } = {}) {
    if (staging) return { started: false, outcome: 'refused', detail: 'This is a staging or check host; it never installs updates.', next: 'Nothing to do here.' };
    const current = await status();
    if (current.running) return { started: false, outcome: 'busy', detail: 'An update is already running.', next: 'Call mars_update_status in a minute to follow it.' };
    const fresh = await check();
    if (!['fast_forward', 'merge'].includes(fresh.state)) return { started: false, outcome: 'nothing_to_do', state: fresh.state, detail: fresh.next, next: fresh.next };
    if (!(await managed())) {
      const detail = 'This Mars is not running as systemd user services, so it cannot restart itself. Stop Mars, then run npm run update -- apply in the Mars folder.';
      return { started: false, outcome: 'refused', detail, next: detail };
    }
    const unit = 'mars-update-' + Date.now().toString(36);
    // If the updater itself is killed, systemd runs `recover --restart` once it has stopped:
    // that finishes or undoes the switch-over and starts both services again.
    const recoverCommand = [process.execPath, join(repo, 'scripts/update.mjs'), 'recover', '--restart', '--json'].map((part) => `"${part.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`).join(' ');
    const args = ['--user', '--no-block', '--collect', '--unit=' + unit, '--property=WorkingDirectory=' + repo,
      '--property=ExecStopPost=' + recoverCommand,
      '--setenv=PATH=' + (env.PATH || ''), '--setenv=HOME=' + (env.HOME || ''), '--setenv=MARS_PI_ROOT=' + root, '--setenv=MARS_REPO_ROOT=' + repo,
      ...['MARS_HOST_SERVICE', 'MARS_UI_SERVICE', 'MARS_PI_PORT', 'MARS_UI_PORT', 'MARS_UI_DIR', 'MARS_UPDATE_REMOTE', 'MARS_UPDATE_BRANCH', 'MARS_UPDATE_HEALTH_SECONDS', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
        .filter((key) => env[key]).map((key) => `--setenv=${key}=${env[key]}`),
      process.execPath, join(repo, 'scripts/update.mjs'), 'apply', '--json', ...(full ? ['--full'] : [])];
    const started = await run(systemdRun, args);
    if (started.code !== 0) return { started: false, outcome: 'failed', detail: 'Could not start the update: ' + started.text.trim().slice(-500), next: 'Run npm run update -- apply on the server and read its output.' };
    return { started: true, outcome: 'started', unit, detail: `Updating to ${fresh.target} (${fresh.behind} new commit${fresh.behind === 1 ? '' : 's'}).`, next: 'Mars builds the new version first, then restarts, which interrupts this conversation for a minute or two. Afterwards call mars_update_status.' };
  }

  async function tick() {
    try {
      const fresh = await check();
      const { settings, running, last } = await status();
      // A target that already failed or rolled back is not retried automatically; a newer commit on main is.
      const failedHere = last && last.outcome !== 'updated' && last.outcome !== 'interrupted' && last.target && last.target === fresh.target;
      if (settings.auto && !running && !failedHere && ['fast_forward', 'merge'].includes(fresh.state) && !(await busy())) {
        const result = await apply();
        log(`Mars update: automatic install ${result.outcome}. ${result.detail}`);
      }
    } catch (error) { log('Mars update check failed: ' + (error?.message || error)); }
  }
  function start() {
    if (staging) return;
    const hours = Number(env.MARS_UPDATE_CHECK_HOURS ?? 6);
    if (!(hours > 0)) return;
    const first = setTimeout(tick, 2 * 60 * 1000);
    timer = setInterval(tick, hours * 3600 * 1000);
    first.unref(); timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); }

  /** The small summary /api/state carries for the sidebar notice. Reads two files, no Git. */
  async function badge() {
    const read = (name) => readFile(join(root, 'updates', name), 'utf8').then(JSON.parse, () => null);
    const [last, journal] = await Promise.all([read('status.json'), read('current.json')]);
    const updating = journal && journal.phase !== 'done' && Date.now() - Date.parse(journal.updatedAt) < 30 * 60 * 1000;
    return { state: updating ? 'updating' : last?.state ?? 'unknown', behind: last?.behind ?? 0 };
  }

  async function route({ req, url, res, send, jsonBody }) {
    if (!url.pathname.startsWith('/api/update')) return false;
    if (url.pathname === '/api/update' && req.method === 'GET') { send(res, 200, await status()); return true; }
    if (url.pathname === '/api/update/check' && req.method === 'POST') { await check(); send(res, 200, await status()); return true; }
    if (url.pathname === '/api/update/apply' && req.method === 'POST') { send(res, 202, await apply()); return true; }
    if (url.pathname === '/api/update/settings' && req.method === 'POST') {
      const { auto } = await jsonBody(req);
      if (typeof auto !== 'boolean') throw Object.assign(Error('Send { auto: true } or { auto: false }'), { status: 400 });
      await (await updater()).setSettings({ auto });
      send(res, 200, await status());
      return true;
    }
    send(res, 404, { error: 'Not found' });
    return true;
  }

  const next = Type.String({ description: 'What to do next, in plain words.' });
  const Blocker = Type.Object({
    code: Type.String({ description: 'Why it cannot update, e.g. "local_changes_overlap" or "conflict".' }),
    message: Type.String({ description: 'The reason and the fix, in plain words.' }),
    files: Type.Optional(Type.Array(Type.String(), { description: 'Files involved, from the repository root.' })),
  });
  const extension = defineExtension({
    name: 'mars-updates',
    marsPlugin: { title: 'Updates', version: '1.0.0', description: 'Check main for a new version of Mars and install it: build beside the running copy, restart, roll back if unhealthy. Conflicts are merged in a separate worktree first.' },
    tools: [
      defineTool({
        name: 'mars_update_status',
        description: `Check whether a newer Mars is on GitHub, and how the last update went.
Use it when the owner asks about Mars updates or its version. Returns state (fast_forward or merge means ready), new commits and blockers. Changes nothing.
Example: await tools.mars_update_status({ refresh: true })`,
        parameters: Type.Object({ refresh: Type.Optional(Type.Boolean({ default: true, description: 'true fetches main first (a few seconds); false shows the last check.' })) }),
        replay: 'safe', deferred: true,
        structuredOutputSchema: Type.Object({
          state: Type.String({ description: 'up_to_date, ahead, fast_forward, merge, needs_reconcile, blocked, updating or unknown.' }),
          behind: Type.Integer({ description: 'New commits on main this copy does not have.' }),
          ahead: Type.Integer({ description: 'Commits this copy has that main does not.' }),
          commits: Type.Array(Type.String(), { description: 'Up to 20 new commits on main, newest first, as "sha subject".' }),
          blockers: Type.Array(Blocker, { description: 'Why it cannot update now. Empty when it can.' }),
          last: Type.Union([Type.Object({
            outcome: Type.String({ description: 'updated, failed, rolled_back, rollback_failed or interrupted.' }),
            detail: Type.String({ description: 'What happened, or what failed and where.' }),
          }, { additionalProperties: true }), Type.Null()], { description: 'The last finished update, or null.' }),
          next,
        }),
        execute: async ({ refresh = true }) => {
          if (refresh) await check();
          const current = await status();
          const last = current.status ?? {};
          return output({
            state: current.running ? 'updating' : last.state ?? 'unknown', behind: last.behind ?? 0, ahead: last.ahead ?? 0,
            commits: last.commits ?? [], blockers: last.blockers ?? [], last: current.last ? { ...current.last, detail: current.last.detail ?? '' } : null,
            next: current.running ? `An update is running (${current.running.step ?? 'starting'}). Check again in a minute.`
              : last.state === 'needs_reconcile' ? 'Tell the owner which files conflict. If they want you to merge them, call mars_update_reconcile_start.'
              : ['fast_forward', 'merge'].includes(last.state) ? 'Tell the owner what is new. If they want it now, call mars_update_apply.'
              : last.next ?? 'Call again with refresh: true.',
          });
        },
      }),
      defineTool({
        name: 'mars_update_apply',
        description: `Install the newer Mars from GitHub, restarting Mars with automatic rollback.
Use it only after mars_update_status says fast_forward or merge and the owner wants it now. The restart interrupts this conversation.
Example: await tools.mars_update_apply({})`,
        parameters: Type.Object({ full: Type.Optional(Type.Boolean({ default: false, description: 'true also runs every host check before switching over (several minutes slower).' })) }),
        replay: 'unsafe', executionMode: 'sequential', deferred: true,
        structuredOutputSchema: Type.Object({
          started: Type.Boolean({ description: 'True when the update began; the restart follows shortly.' }),
          outcome: Type.String({ description: 'started, nothing_to_do, busy, refused or failed.' }),
          detail: Type.String({ description: 'What is happening or why it did not start.' }),
          next,
        }, { additionalProperties: true }),
        execute: async ({ full = false }) => output(await apply({ full })),
      }),
      defineTool({
        name: 'mars_update_reconcile_start',
        description: `Start merging a Mars update that has conflicts, in a separate folder.
Use it only when mars_update_status says needs_reconcile and the owner asks you to merge. Returns the folder and the files to fix.
Example: await tools.mars_update_reconcile_start({})`,
        parameters: Type.Object({}),
        replay: 'unsafe', executionMode: 'sequential', deferred: true,
        structuredOutputSchema: Type.Object({
          started: Type.Boolean({ description: 'True when the worktree is ready to edit.' }),
          state: Type.String({ description: 'The update state found, normally needs_reconcile.' }),
          worktree: Type.Union([Type.String(), Type.Null()], { description: 'Absolute folder to edit in, or null.' }),
          conflicts: Type.Array(Type.String(), { description: 'Files with conflicts, from the repository root.' }),
          next,
        }),
        execute: async () => output(await (await updater()).reconcileStart()),
      }),
      defineTool({
        name: 'mars_update_reconcile_finish',
        description: `Commit the conflict fixes made after mars_update_reconcile_start, ready to install.
Use it when every listed file is fixed. Refuses while conflict markers remain. Then call mars_update_apply.
Example: await tools.mars_update_reconcile_finish({})`,
        parameters: Type.Object({ message: Type.Optional(Type.String({ maxLength: 200, description: 'Commit message. Default: "Merge origin/main (reconciled)".' })) }),
        replay: 'unsafe', executionMode: 'sequential', deferred: true,
        structuredOutputSchema: Type.Object({
          ok: Type.Boolean({ description: 'True when the merge is committed and ready to install.' }),
          commit: Type.Union([Type.String(), Type.Null()], { description: 'The merge commit, or null.' }),
          problems: Type.Array(Type.Object({
            file: Type.String({ description: 'The file to fix, from the repository root, or "" for a general problem.' }),
            detail: Type.String({ description: 'What is wrong and how to fix it.' }),
          }), { description: 'What still needs fixing, first problem first.' }),
          next,
        }),
        execute: async ({ message }) => output(await (await updater()).reconcileFinish({ message })),
      }),
    ],
  });
  return { extension, route, badge, start, stop, status, check, apply, tick };
}
