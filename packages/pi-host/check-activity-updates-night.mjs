// A host_deploy that stopped before writing any status (staging threw, or the call was aborted)
// is dated by its deploy folder's last change, so once a newer build is installed it is history
// and GET /api/host/version stops reporting it. A newer one is still reported as interrupted.
// Temporary folders and a temporary git repository only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHostVersion, latestDeploy } from './host-version.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-night-host-'));
const repo = join(dir, 'repo');
const root = join(dir, 'root');
await mkdir(join(root, 'app'), { recursive: true });
await mkdir(join(root, 'updates'), { recursive: true });
await run('git', ['init', '-q', '-b', 'main', repo]);
await writeFile(join(repo, 'f.txt'), 'x');
await run('git', ['-C', repo, 'add', '.']);
await run('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'one']);
const head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
const version = createHostVersion({ root, appDir: join(root, 'app'), repo, cacheMs: 0 });
try {
  // A deploy folder from January with no status, then a build the updater installed in May.
  const stuck = join(root, 'deploys/20260115T000000000-x');
  await mkdir(stuck, { recursive: true });
  const january = new Date('2026-01-15T00:05:00Z');
  await utimes(stuck, january, january);
  await writeFile(join(root, 'updates/installed.json'), JSON.stringify({ commit: head, at: '2026-05-01T00:00:00Z' }));
  const latest = await latestDeploy(join(root, 'deploys'));
  assert.deepEqual([latest.status, latest.at], ['interrupted', january.toISOString()], 'dated by the folder');
  assert.equal((await version()).latestDeploy, null, 'an interrupted deploy older than the installed build is history');

  // The same deploy after the installed build still shows.
  const june = new Date('2026-06-01T00:00:00Z');
  await utimes(stuck, june, june);
  const v = await version();
  assert.deepEqual([v.interrupted, v.latestDeploy?.status, v.latestDeploy?.at], [true, 'interrupted', june.toISOString()]);
  console.log('PASS activity and updates night: interrupted deploy without status dated by its folder, older than the installed build hidden, newer shown');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
