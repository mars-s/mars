// GET /api/host/version (apps/ui/docs/FULL-CONTROL.md): which commit the live host runs, how far
// main is ahead of it, and whether the latest host_deploy ended badly. Read-only: it never
// changes a deploy or an update. Kept apart from dev-tools.mjs, which is the protected deploy gate.
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse, () => null);
// Only outcomes that may have touched the live app. staging_failed and refused changed nothing.
const PROBLEMS = new Set(['interrupted', 'rolled_back', 'rollback_failed', 'apply_failed', 'schedule_failed']);
const IN_FLIGHT = new Set(['staging', 'scheduled', 'applying', 'restarting']);

async function git(repo, args) {
  try { return (await run('git', ['-C', repo, ...args], { timeout: 10000 })).stdout.trim(); } catch { return null; }
}

/**
 * The latest deploy's state. A deploy with no status after 10 minutes, or one still "in flight"
 * after an hour, stopped without finishing: reported as interrupted (nothing is changed).
 */
export async function latestDeploy(deploysDir, now = Date.now()) {
  const ids = (await readdir(deploysDir).catch(() => [])).sort();
  const id = ids.at(-1);
  if (!id) return null;
  const dir = join(deploysDir, id);
  const state = await readJson(join(dir, 'status.json'));
  const started = (await stat(dir).catch(() => null))?.mtimeMs ?? now;
  if (!state) {
    return now - started > 10 * 60000
      ? { id, status: 'interrupted', detail: 'It stopped before writing any status; the live app was not changed by it.', at: null }
      : { id, status: 'staging', detail: null, at: null };
  }
  const at = Date.parse(state.at ?? '') || started;
  if (IN_FLIGHT.has(state.status) && now - at > 60 * 60000)
    return { id, status: 'interrupted', detail: `It stopped while ${state.status} and never finished.`, at: state.at ?? null };
  return { id, status: state.status, detail: state.detail ?? null, at: state.at ?? null };
}

export function createHostVersion({ root, appDir, repo, cacheMs = 30000 }) {
  let cached = null;
  async function liveCommit() {
    // The updater records what it installed; deployed.json and deploy plans cover host_deploy.
    const installed = await readJson(join(root, 'updates/installed.json'));
    const deployed = await readJson(join(appDir, 'deployed.json'));
    const candidates = [];
    if (installed?.commit) candidates.push({ commit: installed.commit, deployedAt: installed.at ?? null, source: 'updates/installed.json' });
    if (deployed?.commit) candidates.push({ commit: deployed.commit, deployedAt: deployed.deployedAt ?? null, source: 'deployed.json' });
    const deploysDir = join(root, 'deploys');
    for (const id of (await readdir(deploysDir).catch(() => [])).sort().reverse()) {
      const state = await readJson(join(deploysDir, id, 'status.json'));
      if (state?.status !== 'deployed') continue;
      const plan = await readJson(join(deploysDir, id, 'plan.json'));
      if (plan?.commit) candidates.push({ commit: plan.commit, deployedAt: state.at ?? null, source: 'deploys/' + id });
      break;
    }
    // The newest record wins.
    candidates.sort((a, b) => (Date.parse(b.deployedAt ?? '') || 0) - (Date.parse(a.deployedAt ?? '') || 0));
    return candidates[0] ?? { commit: null, deployedAt: null, source: null };
  }
  async function gitFacts(commit) {
    if (cached && cached.commit === commit && Date.now() - cached.at < cacheMs) return cached.facts;
    const repoHead = await git(repo, ['rev-parse', '--verify', 'main^{commit}']);
    const full = commit ? await git(repo, ['rev-parse', '--verify', commit + '^{commit}']) : null;
    const subject = full ? await git(repo, ['log', '-1', '--format=%s', full]) : null;
    const count = repoHead && full ? await git(repo, ['rev-list', '--count', full + '..' + repoHead]) : null;
    const facts = { repoHead, commit: full ?? commit, subject, behind: count === null ? null : Number(count) };
    cached = { commit, at: Date.now(), facts };
    return facts;
  }
  return async function version() {
    const live = await liveCommit();
    const facts = await gitFacts(live.commit);
    const latest = await latestDeploy(join(root, 'deploys'));
    return {
      commit: facts.commit, subject: facts.subject, deployedAt: live.deployedAt, source: live.source,
      repoHead: facts.repoHead, behind: facts.behind,
      interrupted: latest?.status === 'interrupted',
      // A problem older than the build now installed (for example by the updater) is history.
      latestDeploy: latest && PROBLEMS.has(latest.status) && !(live.deployedAt && latest.at && Date.parse(latest.at) < Date.parse(live.deployedAt)) ? latest : null,
    };
  };
}
