// The host version notice ignores deploy outcomes that never touched the live app: a deploy that
// failed in staging, and any problem older than the build now installed (for example one the
// updater installed afterwards). Temporary folders and a temporary git repository only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHostVersion } from './host-version.mjs';

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mars-host-problems-'));
const repo = join(dir, 'repo');
const root = join(dir, 'root');
await mkdir(join(root, 'app'), { recursive: true });
await run('git', ['init', '-q', '-b', 'main', repo]);
await writeFile(join(repo, 'f.txt'), 'x');
await run('git', ['-C', repo, 'add', '.']);
await run('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'one']);
const head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
const version = createHostVersion({ root, appDir: join(root, 'app'), repo, cacheMs: 0 });
const deploy = join(root, 'deploys/20261023T000000000-x');
await mkdir(deploy, { recursive: true });
await mkdir(join(root, 'updates'), { recursive: true });
await writeFile(join(root, 'updates/installed.json'), JSON.stringify({ commit: head, at: '2026-10-23T10:30:00Z' }));
const status = (value) => writeFile(join(deploy, 'status.json'), JSON.stringify(value));
try {
  await status({ status: 'staging_failed', at: '2026-10-23T11:00:00Z', detail: 'Checks failed.' });
  assert.equal((await version()).latestDeploy, null, 'a staging failure changed nothing live');
  await status({ status: 'rolled_back', at: '2026-10-23T09:00:00Z' });
  assert.equal((await version()).latestDeploy, null, 'a rollback before the installed build is history');
  await status({ status: 'rolled_back', at: '2026-10-23T11:00:00Z', detail: 'Unhealthy.' });
  assert.equal((await version()).latestDeploy?.status, 'rolled_back', 'a rollback after it still shows');
  console.log('PASS host version problems: staging failures ignored, older problems ignored, newer rollbacks shown');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
