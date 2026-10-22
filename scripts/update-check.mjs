// Read-only half of the updater (docs/UPDATES.md "Check"): fetch main, gather Git facts and
// turn them into one update state. Nothing here changes the checkout except the fetch.
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Run git without a shell or prompts. Never throws for a non-zero exit. */
export function git(cwd, args, { input, timeoutMs = 60000, env } = {}) {
  return new Promise(resolve => {
    const child = spawn('git', args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', ...env },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 128, stdout, stderr }); });
    child.stdin.on('error', () => {}); // a command that exits without reading stdin (EPIPE on Linux)
    child.stdin.end(input ?? '');
  });
}
const split = text => text.split('\0').filter(Boolean);
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const short = sha => (sha || '').slice(0, 12);

export const UPDATE_STATES = ['up_to_date', 'ahead', 'fast_forward', 'merge', 'needs_reconcile', 'blocked'];
export const INSTALLABLE = new Set(['fast_forward', 'merge']);

/**
 * The update state for a set of Git facts. Pure: every input is in `facts`.
 * Returns { state, blockers: [{ code, message, files? }] }.
 */
export function classify(facts) {
  const block = (code, message, files) => ({ state: 'blocked', blockers: [{ code, message, ...(files?.length ? { files } : {}) }] });
  if (!facts.isRepo) return block('not_git', 'The Mars folder is not a Git checkout, so it cannot update from GitHub. Reinstall it with git clone.');
  if (!facts.fetched || !facts.target) return block('no_remote', `Could not read ${facts.remote}/${facts.branch}: ${facts.fetchError || 'the branch does not exist'}.`);
  if (facts.operation) return block('operation_in_progress', `A git ${facts.operation} is unfinished in the checkout. Finish it or run git ${facts.operation} --abort, then check again.`);
  if (!facts.currentBranch) return block('detached', `The checkout is not on a branch. Run git switch ${facts.branch}, then check again.`);
  if (facts.currentBranch !== facts.branch) return block('wrong_branch', `The checkout is on ${facts.currentBranch}, not ${facts.branch}. Run git switch ${facts.branch}, then check again.`);
  if (facts.deployInProgress) return block('deploy_in_progress', 'A host_deploy is still running. Wait for host_deploy_status to finish, then check again.');
  if (facts.head === facts.target) return { state: 'up_to_date', blockers: [] };
  if (facts.behind === 0) return { state: 'ahead', blockers: [] };
  let state;
  if (facts.ahead === 0) state = 'fast_forward';
  else if (facts.reconciled || facts.mergeClean) state = 'merge';
  else return { state: 'needs_reconcile', blockers: [{ code: 'conflict', message: `This copy and ${facts.branch} both changed the same lines. Merge them by hand (git merge ${facts.remote}/${facts.branch}) or ask Mars to reconcile.`, files: facts.conflicts }] };
  const changed = new Set(facts.updateChanges);
  const overlap = facts.uncommitted.filter(path => changed.has(path));
  if (overlap.length) return block('local_changes_overlap', 'Uncommitted changes in the checkout touch files this update changes. Commit them (they will be merged) or discard them, then check again.', overlap);
  const added = new Set(facts.updateAdds);
  const clash = facts.addsPresent ?? facts.untracked.filter(path => added.has(path));
  if (clash.length) return block('untracked_overwritten', 'Files in the checkout that Git does not track (some may be ignored) have the same name as files this update adds. Move them away, then check again.', clash);
  return { state, blockers: [] };
}

const OPERATIONS = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];
async function operation(repo) {
  for (const [name, label] of OPERATIONS) {
    const path = (await git(repo, ['rev-parse', '--git-path', name])).stdout.trim();
    if (path && await readFile(join(repo, path)).then(() => true, error => error.code === 'EISDIR')) return label;
  }
  return null;
}

/** The most recent host_deploy that has not finished (dev-tools.mjs writes these). */
export async function deployInProgress(root) {
  const ids = (await readdir(join(root, 'deploys')).catch(() => [])).sort();
  const latest = ids.at(-1);
  if (!latest) return false;
  const status = await readFile(join(root, 'deploys', latest, 'status.json'), 'utf8').then(JSON.parse, () => ({}));
  return ['scheduled', 'applying', 'restarting'].includes(status.status) && Date.now() - Date.parse(status.at) < 30 * 60 * 1000;
}

/** A finished reconcile commit (docs/UPDATES.md "Reconcile"), if it still fits HEAD and the target. */
async function reconcileCommit(repo, root, head, target) {
  const saved = await readFile(join(root, 'updates/reconcile.json'), 'utf8').then(JSON.parse, () => null);
  if (!saved?.commit) return null;
  const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', saved.commit])).stdout.trim().split(' ').slice(1);
  return parents[0] === head && parents[1] === target ? saved.commit : null;
}

/** Fetch and gather every fact classify() needs, plus what an update would install. */
export async function gatherFacts({ repo, root, remote = 'origin', branch = 'main', fetch = true }) {
  const facts = { remote, branch, isRepo: false, fetched: false, uncommitted: [], untracked: [], updateChanges: [], updateAdds: [], conflicts: [], commits: [] };
  const top = await git(repo, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return facts;
  facts.isRepo = true;
  if (fetch) {
    const fetched = await git(repo, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    if (fetched.code !== 0) {
      // Git's first error line names the cause; later lines are generic advice.
      const reason = fetched.stderr.split('\n').map(line => line.replace(/^(fatal|error): /, '').trim()).find(Boolean);
      facts.fetchError = (reason || 'git fetch failed').slice(0, 300);
      return facts;
    }
  }
  const target = await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}^{commit}`]);
  if (target.code !== 0) return facts;
  facts.fetched = true;
  facts.target = target.stdout.trim();
  facts.head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  facts.currentBranch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || null;
  facts.operation = await operation(repo);
  facts.deployInProgress = await deployInProgress(root);
  const [ahead, behind] = (await git(repo, ['rev-list', '--left-right', '--count', `${facts.head}...${facts.target}`])).stdout.trim().split(/\s+/).map(Number);
  Object.assign(facts, { ahead: ahead || 0, behind: behind || 0 });
  facts.commits = lines((await git(repo, ['log', '--format=%h %s', '-n', '20', `${facts.head}..${facts.target}`])).stdout);
  // --no-renames: a staged rename counts as its old path and its new path.
  facts.uncommitted = split((await git(repo, ['diff', '--name-only', '-z', '--no-renames', 'HEAD'])).stdout);
  facts.untracked = split((await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout).filter(path => !/(^|\/)node_modules$/.test(path));
  if (facts.behind === 0) return facts;
  // What HEAD would become: the target, a finished reconcile, or a clean merge tree.
  let resultTree = facts.target;
  if (facts.ahead > 0) {
    facts.reconciled = await reconcileCommit(repo, root, facts.head, facts.target);
    if (facts.reconciled) resultTree = facts.reconciled;
    else {
      const merge = await git(repo, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', facts.head, facts.target]);
      const [tree, ...conflicts] = split(merge.stdout);
      facts.mergeClean = merge.code === 0;
      if (merge.code === 1) facts.conflicts = [...new Set(conflicts)];
      else if (merge.code !== 0) { facts.mergeClean = false; facts.conflicts = []; facts.mergeError = merge.stderr.trim().slice(0, 300); }
      if (facts.mergeClean) { facts.mergeTree = tree; resultTree = tree; }
    }
  }
  if (facts.ahead === 0 || facts.reconciled || facts.mergeClean) {
    facts.updateChanges = split((await git(repo, ['diff', '--name-only', '-z', '--no-renames', facts.head, resultTree])).stdout);
    facts.updateAdds = split((await git(repo, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', facts.head, resultTree])).stdout);
    // An added path is untracked at HEAD, so anything already there (ignored or not) would be overwritten.
    const present = await Promise.all(facts.updateAdds.map(path => lstat(join(repo, path)).then(() => path, () => null)));
    facts.addsPresent = present.filter(Boolean);
  }
  return facts;
}

/** The status document written to updates/status.json and shown everywhere. */
export function describe(facts, verdict, checkedAt = new Date().toISOString()) {
  const next = {
    up_to_date: 'Mars is up to date. Nothing to do.',
    ahead: `This copy has commits ${facts.branch} does not. Nothing to install; push them to GitHub if they should be kept.`,
    fast_forward: `${facts.behind} new commit${facts.behind === 1 ? '' : 's'} on ${facts.branch}. Update when ready.`,
    merge: facts.reconciled
      ? `A reconciled merge of ${facts.branch} is ready. Update when ready.`
      : `${facts.behind} new commit${facts.behind === 1 ? '' : 's'} on ${facts.branch}, and this copy has ${facts.ahead} of its own. They merge cleanly. Update when ready.`,
    needs_reconcile: verdict.blockers[0]?.message,
    blocked: verdict.blockers[0]?.message,
  }[verdict.state];
  return {
    state: verdict.state, checkedAt, remote: facts.remote, branch: facts.branch,
    head: short(facts.head), target: short(facts.target), behind: facts.behind ?? 0, ahead: facts.ahead ?? 0,
    commits: facts.commits, blockers: verdict.blockers, reconciled: !!facts.reconciled, next,
  };
}
