// Push local commits to GitHub without git credentials, through the Git Data API
// (docs/GITHUB.md). Each commit is rebuilt on GitHub with the same tree, parents,
// author, committer and message, so GitHub computes the identical SHA. Every returned
// SHA is checked and the branch only moves forward (never forced).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export class GithubSyncError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Run a program; resolves { code, stdout: Buffer, stderr: string }. */
export function run(cmd, args, { cwd, input, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export async function git(repo, args, opts = {}) {
  const r = await run('git', ['-C', repo, ...args], opts);
  if (r.code !== 0 && !opts.allowFail) throw new GithubSyncError('git_error', `git ${args[0]} failed: ${r.stderr.trim().slice(0, 500)}`);
  return opts.raw ? r : r.stdout.toString('utf8');
}

const utf8 = (buf, what) => {
  const s = buf.toString('utf8');
  if (!Buffer.from(s, 'utf8').equals(buf)) throw new GithubSyncError('unsupported_commit', `${what} is not valid UTF-8, so GitHub cannot reproduce it.`);
  return s;
};

/** Git "1700000000 +1000" to ISO 8601 with the same offset. */
export function isoDate(epoch, tz) {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(tz);
  if (!m) throw new GithubSyncError('unsupported_commit', `Unusual timezone ${tz}.`);
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const local = new Date((Number(epoch) + minutes * 60) * 1000).toISOString().slice(0, 19);
  return local + (minutes === 0 && m[1] === '+' ? 'Z' : `${m[1]}${m[2]}:${m[3]}`);
}

function person(line, sha) {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) throw new GithubSyncError('unsupported_commit', `Commit ${sha} has an identity line GitHub cannot reproduce.`);
  return { name: m[1], email: m[2], date: isoDate(m[3], m[4]) };
}

/** Parse a raw commit object. Refuses headers GitHub cannot recreate (signatures, encoding). */
export function parseCommit(raw, sha) {
  const split = raw.indexOf('\n\n');
  const head = utf8(split < 0 ? raw : raw.subarray(0, split), `Commit ${sha} header`);
  const message = split < 0 ? '' : utf8(raw.subarray(split + 2), `Commit ${sha} message`);
  const c = { sha, parents: [], message };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === 'tree') c.tree = value;
    else if (key === 'parent') c.parents.push(value);
    else if (key === 'author') c.author = person(value, sha);
    else if (key === 'committer') c.committer = person(value, sha);
    else if (key === 'gpgsig' || key === 'gpgsig-sha256' || line.startsWith(' ') && c.signed) {
      c.signed = true;
    } else throw new GithubSyncError('unsupported_commit', `Commit ${sha} has a "${key || line.slice(0, 20)}" header GitHub cannot recreate.`);
  }
  if (c.signed) throw new GithubSyncError('unsupported_commit', `Commit ${sha.slice(0, 12)} is signed. GitHub cannot recreate a signed commit with the same SHA. Re-create it unsigned (e.g. git -c commit.gpgsign=false commit --amend --no-edit) and try again.`);
  return c;
}

/** Changed paths between two commits (or from nothing for a root commit). */
export async function changes(repo, parent, sha) {
  const args = ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-commit-id'];
  const r = await git(repo, parent ? [...args, parent, sha] : [...args, '--root', sha], { raw: true });
  const parts = r.stdout.toString('latin1').split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = parts[i].replace(/^:/, '').split(' ');
    if (!status) break;
    const path = utf8(Buffer.from(parts[i + 1], 'latin1'), `Path in ${sha}`);
    out.push({ oldMode, newMode, oldSha, newSha, status: status[0], path });
  }
  return out;
}

const seg = (s) => s.split('/').map(encodeURIComponent).join('/');
const ok = (r) => r.status >= 200 && r.status < 300;
const apiFail = (what, r) => new GithubSyncError('api_error', `GitHub refused to ${what} (HTTP ${r.status}): ${r.data?.message ?? JSON.stringify(r.data).slice(0, 300)}`);

export function parseRemote(value) {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(value ?? '').trim());
  if (!m) throw new GithubSyncError('bad_input', `"${value}" is not a GitHub repository. Use "owner/name", e.g. "mars-s/mars".`);
  return `${m[1]}/${m[2]}`;
}

/**
 * Replay the local commits that the GitHub branch lacks. api.request(method, path, body)
 * resolves { status, data }. Returns { status: "pushed" | "up_to_date", pushed, commits, ... }.
 * Throws GithubSyncError: needs_pull, empty_repo, unsupported_commit, sha_mismatch, api_error.
 */
export async function pushCommits({ repo, branch, remote, api, maxCommits = 500 }) {
  remote = parseRemote(remote);
  const bad = await git(repo, ['check-ref-format', '--branch', String(branch)], { raw: true, allowFail: true });
  if (!branch || bad.code !== 0) throw new GithubSyncError('bad_input', `"${branch}" is not a valid branch name.`);
  const lr = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { raw: true, allowFail: true });
  if (lr.code !== 0) throw new GithubSyncError('bad_input', `There is no local branch "${branch}" in ${repo}.`);
  const local = lr.stdout.toString().trim();
  const base = `/repos/${remote}`;
  const has = async (sha) => (await git(repo, ['cat-file', '-e', `${sha}^{commit}`], { raw: true, allowFail: true })).code === 0;
  const head = async (name) => {
    const r = await api.request('GET', `${base}/git/ref/heads/${seg(name)}`);
    if (r.status === 404) return null;
    if (r.status === 409) throw new GithubSyncError('empty_repo', `${remote} on GitHub is empty. Add a first commit there (for example a README in the GitHub web page), fetch it, then push again.`);
    if (!ok(r)) throw apiFail(`read branch ${name}`, r);
    return r.data.object.sha;
  };
  const remoteBefore = await head(branch);
  const result = (status, commits) => ({ status, pushed: commits.length, commits, branch, remote, remoteBefore, remoteAfter: status === 'pushed' ? local : remoteBefore });
  let exclude;
  if (remoteBefore) {
    if (remoteBefore === local) return result('up_to_date', []);
    if (!await has(remoteBefore)) throw new GithubSyncError('needs_pull', `GitHub's ${branch} is at ${remoteBefore.slice(0, 12)}, which this checkout does not have. Fetch it (git fetch), rebase or merge onto it, then push again.`);
    const anc = await git(repo, ['merge-base', '--is-ancestor', remoteBefore, local], { raw: true, allowFail: true });
    if (anc.code !== 0) throw new GithubSyncError('needs_pull', `Local ${branch} and GitHub's ${branch} have diverged (GitHub is at ${remoteBefore.slice(0, 12)}). Rebase or merge onto GitHub's branch first; this never force-pushes.`);
    exclude = remoteBefore;
  } else {
    const info = await api.request('GET', base);
    if (!ok(info)) throw apiFail(`read repository ${remote}`, info);
    const def = await head(info.data.default_branch);
    if (!def) throw new GithubSyncError('empty_repo', `${remote} has no default branch on GitHub yet. Add a first commit there, then push again.`);
    if (!await has(def)) throw new GithubSyncError('needs_pull', `GitHub's ${info.data.default_branch} is at ${def.slice(0, 12)}, which this checkout does not have. Fetch it first (git fetch), then push again.`);
    exclude = def;
  }
  const list = (await git(repo, ['rev-list', '--reverse', '--topo-order', local, `^${exclude}`])).split('\n').filter(Boolean);
  if (list.length > maxCommits) throw new GithubSyncError('bad_input', `${list.length} commits to push; the limit is ${maxCommits} per push.`);
  const commits = [];
  for (const sha of list) commits.push(parseCommit((await git(repo, ['cat-file', 'commit', sha], { raw: true })).stdout, sha));
  const blobs = new Set();
  for (const c of commits) {
    const parent = c.parents[0];
    const entries = [];
    for (const ch of await changes(repo, parent, c.sha)) {
      if (ch.status === 'D') { entries.push({ path: ch.path, mode: ch.oldMode, type: ch.oldMode === '160000' ? 'commit' : 'blob', sha: null }); continue; }
      if (ch.newMode === '160000') { entries.push({ path: ch.path, mode: '160000', type: 'commit', sha: ch.newSha }); continue; }
      if (ch.oldSha !== ch.newSha && !blobs.has(ch.newSha)) {
        const content = (await git(repo, ['cat-file', 'blob', ch.newSha], { raw: true })).stdout.toString('base64');
        const r = await api.request('POST', `${base}/git/blobs`, { content, encoding: 'base64' });
        if (!ok(r)) throw apiFail(`create the blob for ${ch.path}`, r);
        if (r.data.sha !== ch.newSha) throw new GithubSyncError('sha_mismatch', `GitHub stored ${ch.path} as blob ${r.data.sha}, not ${ch.newSha}. Nothing was pushed.`);
        blobs.add(ch.newSha);
      }
      entries.push({ path: ch.path, mode: ch.newMode, type: 'blob', sha: ch.newSha });
    }
    let parentTree = null;
    if (parent) parentTree = (await git(repo, ['rev-parse', `${parent}^{tree}`])).trim();
    if (entries.length || !parentTree) {
      const r = await api.request('POST', `${base}/git/trees`, parentTree ? { base_tree: parentTree, tree: entries } : { tree: entries });
      if (!ok(r)) throw apiFail(`create the tree for ${c.sha.slice(0, 12)}`, r);
      if (r.data.sha !== c.tree) throw new GithubSyncError('sha_mismatch', `GitHub built tree ${r.data.sha} for commit ${c.sha.slice(0, 12)}, expected ${c.tree}. Nothing was pushed.`);
    }
    const r = await api.request('POST', `${base}/git/commits`, { message: c.message, tree: c.tree, parents: c.parents, author: c.author, committer: c.committer });
    if (!ok(r)) throw apiFail(`create commit ${c.sha.slice(0, 12)}`, r);
    if (r.data.sha !== c.sha) throw new GithubSyncError('sha_mismatch', `GitHub made commit ${r.data.sha} for local ${c.sha}, so the history would differ. The branch was not moved. Check the author, committer, dates and message of that commit.`);
  }
  const ref = remoteBefore
    ? await api.request('PATCH', `${base}/git/refs/heads/${seg(branch)}`, { sha: local, force: false })
    : await api.request('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: local });
  if (!ok(ref)) throw apiFail(`move ${branch} to ${local.slice(0, 12)} (fast-forward only)`, ref);
  if (ref.data?.object?.sha !== local) throw new GithubSyncError('sha_mismatch', `GitHub's ${branch} now points at ${ref.data?.object?.sha}, expected ${local}.`);
  // Keep the local remote-tracking ref honest when a remote points at this repository.
  for (const name of (await git(repo, ['remote'])).split('\n').filter(Boolean)) {
    const url = (await git(repo, ['remote', 'get-url', name], { raw: true, allowFail: true })).stdout.toString().trim();
    try { if (parseRemote(url).toLowerCase() === remote.toLowerCase()) await git(repo, ['update-ref', `refs/remotes/${name}/${branch}`, local]); } catch {}
  }
  return result('pushed', list);
}

export const INSTALL_STEP = 'Install the Composio CLI for this user: curl -fsSL https://composio.dev/install | COMPOSIO_INSTALL_SHELL=none COMPOSIO_INSTALL_PLUGINS=0 sh';
export const LOGIN_STEP = 'Sign in to Composio in a terminal on this machine: ~/.local/bin/composio login';
export const LINK_STEP = 'Connect GitHub to Composio: ~/.local/bin/composio link github (approve the account that can push to the repository)';

/** The composio executable: MARS_COMPOSIO_BIN, then PATH, then the installer's default places. */
export function findComposio(env = process.env) {
  if (env.MARS_COMPOSIO_BIN) return existsSync(env.MARS_COMPOSIO_BIN) ? env.MARS_COMPOSIO_BIN : null;
  const dirs = [...String(env.PATH ?? '').split(delimiter).filter(Boolean), join(homedir(), '.local/bin'), join(homedir(), '.composio')];
  for (const dir of dirs) if (existsSync(join(dir, 'composio'))) return join(dir, 'composio');
  return null;
}

/**
 * GitHub API through "composio proxy <url> --toolkit github". Bodies go through stdin
 * ("-d -"), never the command line. The CLI prints the response body on stdout and
 * "Status: N" in its log; when the status line is missing, a GitHub error body
 * ({ message }) without the fields of a success is treated as a failure.
 */
export function composioApi({ bin, account, env = process.env, timeoutMs = 120000 } = {}) {
  return {
    async request(method, path, body) {
      const args = ['proxy', 'https://api.github.com' + path, '--toolkit', 'github', '--method', method,
        '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
      if (account) args.push('--account', account);
      if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', '-');
      let r;
      try { r = await run(bin, args, { input: body === undefined ? '' : JSON.stringify(body), env, timeoutMs }); }
      catch (e) { throw new GithubSyncError('needs_setup', `The Composio CLI could not be started (${e.code ?? e.message}).`, { ownerSteps: [INSTALL_STEP, LOGIN_STEP, LINK_STEP] }); }
      const out = r.stdout.toString('utf8').trim();
      const all = r.stderr + '\n' + out;
      if (r.code !== 0) {
        if (/not logged in|composio login/i.test(all)) throw new GithubSyncError('needs_setup', 'The Composio CLI is not signed in.', { ownerSteps: [LOGIN_STEP, LINK_STEP] });
        if (/no active connection|not connected|composio link/i.test(all)) throw new GithubSyncError('needs_setup', 'GitHub is not connected to Composio.', { ownerSteps: [LINK_STEP] });
        throw new GithubSyncError('api_error', `composio proxy ${method} ${path} failed (exit ${r.code}): ${all.trim().slice(-400)}`);
      }
      let data = out;
      if (!out) data = null;
      else try { data = JSON.parse(out); } catch { const i = out.search(/^[{[]/m); if (i >= 0) try { data = JSON.parse(out.slice(i)); } catch {} }
      const m = /Status:\s*(\d{3})/.exec(all);
      let status = m ? Number(m[1]) : 200;
      if (!m && data && typeof data === 'object' && typeof data.message === 'string' && !data.sha && !data.object && !data.default_branch)
        status = /not found/i.test(data.message) ? 404 : /empty/i.test(data.message) ? 409 : 422;
      return { status, data };
    },
  };
}

const Result = Type.Object({
  status: Type.Union(['pushed', 'up_to_date', 'needs_setup', 'needs_pull'].map((s) => Type.Literal(s)), { description: '"pushed" commits went up, "up_to_date" nothing to push, "needs_setup" the owner must do ownerSteps, "needs_pull" GitHub has commits this checkout lacks.' }),
  pushed: Type.Integer({ description: 'How many commits were pushed.' }),
  commits: Type.Array(Type.String(), { description: 'The pushed commit SHAs, oldest first.' }),
  branch: Type.String({ description: 'The branch pushed.' }),
  remote: Type.String({ description: 'The GitHub repository, owner/name.' }),
  remoteBefore: Type.Union([Type.String(), Type.Null()], { description: "GitHub's branch SHA before, or null when the branch was new or unknown." }),
  remoteAfter: Type.Union([Type.String(), Type.Null()], { description: "GitHub's branch SHA after." }),
  message: Type.String({ description: 'One sentence saying what happened or what to do next.' }),
  ownerSteps: Type.Array(Type.String(), { description: 'Steps only the owner can do (install, sign in, connect GitHub). Empty unless status is "needs_setup".' }),
});

/** Agent tool github_push. bin overrides where the Composio CLI is found (tests). */
export function createGithubExtension({ cwd = process.cwd(), bin, env = process.env } = {}) {
  return defineExtension({
    name: 'mars-github',
    tools: [defineTool({
      name: 'github_push',
      description: `Push a local git branch's new commits to GitHub through the owner's Composio GitHub connection.
Use it instead of "git push", which has no GitHub login on this machine. Commit first with host_exec (git add, git commit). It replays each commit GitHub lacks with the same SHA, then moves the GitHub branch forward; it never force-pushes and creates the branch if it is new.
Returns status "pushed" with the count, "up_to_date", "needs_pull" (fetch and rebase or merge first, then call again) or "needs_setup" with ownerSteps to tell the owner (install the Composio CLI, composio login, composio link github). Signed commits are refused. It throws if GitHub's SHA would differ, leaving the branch unmoved. Safe to run again.
Example: await tools.github_push({ repoPath: "/home/bot/ChatGPT/mars", branch: "main", remote: "mars-s/mars" })`,
      parameters: Type.Object({
        repoPath: Type.String({ minLength: 1, description: 'The git checkout, absolute or relative to the workspace, e.g. "/home/bot/ChatGPT/mars".' }),
        branch: Type.Optional(Type.String({ minLength: 1, description: 'Local branch to push to the GitHub branch of the same name, e.g. "main". Default: the branch checked out.' })),
        remote: Type.Optional(Type.String({ minLength: 3, description: 'GitHub repository as "owner/name", e.g. "mars-s/mars". A github.com URL also works. Default: the origin remote.' })),
      }),
      structuredOutputSchema: Result,
      prepareArguments: (a) => (a && typeof a === 'object' && !a.repoPath && (a.repo || a.path) ? { ...a, repoPath: a.repo ?? a.path, repo: undefined, path: undefined } : a),
      deferred: true,
      replay: 'unsafe',
      execute: async (args) => {
        const value = await githubPush({ ...args, cwd, bin, env });
        return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
      },
    })],
  });
}

export async function githubPush({ repoPath, branch, remote, cwd = process.cwd(), bin, env = process.env }) {
  const repo = isAbsolute(repoPath) ? repoPath : resolve(cwd, repoPath);
  const top = await git(repo, ['rev-parse', '--show-toplevel'], { raw: true, allowFail: true });
  if (top.code !== 0) throw new GithubSyncError('bad_input', `${repo} is not a git checkout. Pass repoPath of a git repository.`);
  if (!branch) {
    const b = await git(repo, ['symbolic-ref', '--short', 'HEAD'], { raw: true, allowFail: true });
    if (b.code !== 0) throw new GithubSyncError('bad_input', 'HEAD is detached. Pass branch, e.g. "main".');
    branch = b.stdout.toString().trim();
  }
  if (!remote) {
    const u = await git(repo, ['remote', 'get-url', 'origin'], { raw: true, allowFail: true });
    if (u.code !== 0) throw new GithubSyncError('bad_input', 'There is no origin remote. Pass remote as "owner/name".');
    remote = u.stdout.toString().trim();
  }
  remote = parseRemote(remote);
  const base = { pushed: 0, commits: [], branch, remote, remoteBefore: null, remoteAfter: null, ownerSteps: [] };
  const exe = bin === undefined ? findComposio(env) : bin && existsSync(bin) ? bin : null;
  if (!exe) return { ...base, status: 'needs_setup', message: 'The Composio CLI is not installed. Ask the owner to do ownerSteps, then call github_push again.', ownerSteps: [INSTALL_STEP, LOGIN_STEP, LINK_STEP] };
  try {
    const r = await pushCommits({ repo, branch, remote, api: composioApi({ bin: exe, env }) });
    const message = r.status === 'pushed' ? `Pushed ${r.pushed} commit${r.pushed === 1 ? '' : 's'} to ${remote} ${branch}.` : `GitHub's ${branch} already matches the local branch; nothing to push.`;
    return { ...base, ...r, message };
  } catch (e) {
    if (e.code === 'needs_setup') return { ...base, status: 'needs_setup', message: e.message + ' Ask the owner to do ownerSteps, then call github_push again.', ownerSteps: e.ownerSteps };
    if (e.code === 'needs_pull') return { ...base, status: 'needs_pull', message: e.message };
    throw e;
  }
}
