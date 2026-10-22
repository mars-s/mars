// GET /api/host/version against temporary folders and a temporary git repository: the newest
// install record wins, behind counts commits on main, and an unfinished deploy is reported as
// interrupted without changing anything.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHostVersion, latestDeploy } from './host-version.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-host-version-'));
const repo = join(dir, 'repo');
const root = join(dir, 'root');
const app = join(root, 'app');
await mkdir(app, { recursive: true });
await run('git', ['init', '-q', '-b', 'main', repo]);
const commit = async (message) => {
  await writeFile(join(repo, 'file.txt'), message);
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', message]);
  return (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
};
try {
  const first = await commit('first');
  await commit('second');
  const head = await commit('third');
  const version = createHostVersion({ root, appDir: app, repo, cacheMs: 0 });
  assert.deepEqual(await version(), { commit: null, subject: null, deployedAt: null, source: null, repoHead: head, behind: null, interrupted: false, latestDeploy: null });

  // An old host_deploy record, then a newer updater install record.
  await mkdir(join(root, 'deploys/20261020T000000000-a'), { recursive: true });
  await writeFile(join(root, 'deploys/20261020T000000000-a/status.json'), JSON.stringify({ status: 'deployed', at: '2026-10-20T00:00:00Z' }));
  await writeFile(join(root, 'deploys/20261020T000000000-a/plan.json'), JSON.stringify({ commit: first }));
  let v = await version();
  assert.deepEqual([v.commit, v.subject, v.behind, v.source], [first, 'first', 2, 'deploys/20261020T000000000-a']);
  await mkdir(join(root, 'updates'), { recursive: true });
  await writeFile(join(root, 'updates/installed.json'), JSON.stringify({ commit: head, at: '2026-10-22T00:00:00Z' }));
  v = await version();
  assert.deepEqual([v.commit, v.behind, v.source, v.latestDeploy], [head, 0, 'updates/installed.json', null]);

  // A deploy folder with no status, old enough: interrupted. A fresh one: still staging.
  const stuck = join(root, 'deploys/20261022T000000000-b');
  await mkdir(stuck);
  assert.equal((await latestDeploy(join(root, 'deploys'))).status, 'staging');
  const old = new Date(Date.now() - 20 * 60000);
  await utimes(stuck, old, old);
  v = await version();
  assert.equal(v.interrupted, true);
  assert.equal(v.latestDeploy.status, 'interrupted');
  await writeFile(join(stuck, 'status.json'), JSON.stringify({ status: 'rolled_back', at: new Date().toISOString(), detail: 'Unhealthy.' }));
  v = await version();
  assert.deepEqual([v.interrupted, v.latestDeploy.status, v.latestDeploy.detail], [false, 'rolled_back', 'Unhealthy.']);
  await writeFile(join(stuck, 'status.json'), JSON.stringify({ status: 'applying', at: new Date(Date.now() - 2 * 3600000).toISOString() }));
  assert.equal((await latestDeploy(join(root, 'deploys'))).status, 'interrupted', 'a deploy stuck applying for two hours');
  console.log('PASS host version: no records, deploy plan, newer updater record wins, behind count, interrupted without status, staging while fresh, rolled back, stuck applying');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
