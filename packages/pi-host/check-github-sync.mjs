// github-sync.mjs against a fake GitHub API built on a local bare repository
// (github-fake.mjs, docs/GITHUB.md). No network: SHAs match only if the replay is exact.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import { createFakeGithub } from './github-fake.mjs';
import { createGithubExtension, git, githubPush, isoDate, pushCommits } from './github-sync.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-github-'));
const remote = 'owner/repo';
const bare = join(dir, 'remote.git');
const work = join(dir, 'work');
let clock = 1700000000;
const sh = (repo, args, opts) => git(repo, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], opts);
async function commit(repo, message, { tz = '+1000', committerTz = '-0530', author = 'Ada Lovelace', verbatim = false } = {}) {
  clock += 3600;
  const env = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: `${clock} ${tz}`,
    GIT_COMMITTER_NAME: 'Pi Bot Box', GIT_COMMITTER_EMAIL: 'bot@example.org', GIT_COMMITTER_DATE: `${clock + 61} ${committerTz}` };
  await sh(repo, ['add', '-A']);
  await sh(repo, ['commit', '-q', '--allow-empty', ...(verbatim ? ['--cleanup=verbatim'] : []), '-F', '-'], { env, input: message });
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}
const remoteHead = async (b = 'main') => (await git(bare, ['rev-parse', 'refs/heads/' + b])).trim();
const localHead = async (b = 'main') => (await git(work, ['rev-parse', 'refs/heads/' + b])).trim();
const posts = (fake) => fake.calls.filter((c) => c.method !== 'GET');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok   ' + name); };

try {
  await test('isoDate keeps the timezone', async () => {
    assert.equal(isoDate('1700000000', '+1000'), '2023-11-15T08:13:20+10:00');
    assert.equal(isoDate('1700000000', '-0530'), '2023-11-14T16:43:20-05:30');
    assert.equal(isoDate('1700000000', '+0000'), '2023-11-14T22:13:20Z');
  });

  await git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  await git(dir, ['init', '-q', '-b', 'main', work]);
  const fake = () => createFakeGithub({ bare, remote });

  await test('empty GitHub repository is refused with a clear step', async () => {
    await writeFile(join(work, 'README.md'), '# Demo\n');
    await commit(work, 'Initial commit\n');
    await assert.rejects(pushCommits({ repo: work, branch: 'main', remote, api: fake() }), (e) => e.code === 'empty_repo' && /first commit/.test(e.message));
    await git(work, ['push', '-q', bare, 'main']);
  });

  await test('adds, edits, deletes, executable, symlink and unicode paths, several commits, same SHAs', async () => {
    await mkdir(join(work, 'dir/deep'), { recursive: true });
    await writeFile(join(work, 'dir/a.txt'), 'a\n');
    await writeFile(join(work, 'dir/deep/b.txt'), 'b\n');
    await writeFile(join(work, 'run.sh'), '#!/bin/sh\necho hi\n'); await chmod(join(work, 'run.sh'), 0o755);
    await symlink('README.md', join(work, 'link'));
    await writeFile(join(work, 'café ü.md'), 'unicode\n');
    await writeFile(join(work, 'bin.dat'), Buffer.from([0, 255, 1, 254, 10]));
    const c1 = await commit(work, 'Add files\n\nWith a body line.\n');
    await writeFile(join(work, 'README.md'), '# Demo\n\nEdited.\n');
    await unlink(join(work, 'dir/a.txt'));
    await chmod(join(work, 'run.sh'), 0o644);
    await unlink(join(work, 'link')); await symlink('dir/deep/b.txt', join(work, 'link'));
    await commit(work, 'Edit, delete, chmod and retarget', { tz: '+0545', committerTz: '+0000', verbatim: true });
    await git(work, ['rm', '-rq', 'dir']);
    await mkdir(join(work, 'dir')); await writeFile(join(work, 'dir.txt'), 'x');
    await commit(work, 'Remove a whole folder\n', { tz: '-0800', author: 'Zoë Ñandú' });
    await commit(work, 'An empty commit\n');
    const f = fake();
    const r = await pushCommits({ repo: work, branch: 'main', remote, api: f });
    assert.equal(r.status, 'pushed'); assert.equal(r.pushed, 4); assert.equal(r.commits[0], c1);
    assert.equal(await remoteHead(), await localHead(), 'GitHub branch equals local branch');
    assert.ok(!posts(f).some((c) => c.body?.force), 'never forces');
    assert.equal((await git(bare, ['fsck', '--strict'], { raw: true, allowFail: true })).code, 0, 'remote repository is sound');
  });

  await test('re-run pushes nothing', async () => {
    const f = fake();
    const r = await pushCommits({ repo: work, branch: 'main', remote, api: f });
    assert.equal(r.status, 'up_to_date'); assert.equal(r.pushed, 0); assert.equal(posts(f).length, 0);
  });

  await test('refuses when GitHub has commits this checkout lacks, then when diverged', async () => {
    const other = join(dir, 'other');
    await git(dir, ['clone', '-q', bare, other]);
    await writeFile(join(other, 'theirs.txt'), 'theirs\n');
    await commit(other, 'Their change\n');
    await git(other, ['push', '-q', 'origin', 'main']);
    const before = await remoteHead();
    await writeFile(join(work, 'mine.txt'), 'mine\n');
    await commit(work, 'My change\n');
    const f = fake();
    await assert.rejects(pushCommits({ repo: work, branch: 'main', remote, api: f }), (e) => e.code === 'needs_pull' && /does not have/.test(e.message));
    await git(work, ['fetch', '-q', bare, 'main']);
    await assert.rejects(pushCommits({ repo: work, branch: 'main', remote, api: f }), (e) => e.code === 'needs_pull' && /diverged/.test(e.message));
    assert.equal(posts(f).length, 0); assert.equal(await remoteHead(), before, 'GitHub branch untouched');
    await sh(work, ['rebase', '-q', 'FETCH_HEAD'], { env: { ...process.env, GIT_COMMITTER_DATE: '1700500000 +1000' } });
    const r = await pushCommits({ repo: work, branch: 'main', remote, api: fake() });
    assert.equal(r.pushed, 1); assert.equal(await remoteHead(), await localHead());
  });

  await test('merge commits and a new branch', async () => {
    await sh(work, ['checkout', '-q', '-b', 'night/feature']);
    await writeFile(join(work, 'feature.txt'), 'f1\n'); await commit(work, 'Feature one\n');
    await writeFile(join(work, 'feature.txt'), 'f2\n'); await commit(work, 'Feature two\n');
    await sh(work, ['checkout', '-q', 'main']);
    await writeFile(join(work, 'main.txt'), 'm\n'); await commit(work, 'Main moves\n');
    await sh(work, ['merge', '-q', '--no-ff', '-m', 'Merge feature', 'night/feature'], { env: { ...process.env, GIT_COMMITTER_DATE: '1700600000 +1000', GIT_AUTHOR_DATE: '1700600000 +1000' } });
    const r = await pushCommits({ repo: work, branch: 'main', remote, api: fake() });
    assert.equal(r.pushed, 4); assert.equal(await remoteHead(), await localHead());
    const nb = await pushCommits({ repo: work, branch: 'night/feature', remote, api: fake() });
    assert.equal(nb.status, 'pushed'); assert.equal(nb.pushed, 0, 'commits already on GitHub are not resent');
    assert.equal(await remoteHead('night/feature'), await localHead('night/feature'));
    await sh(work, ['checkout', '-q', '-b', 'night/new']);
    await writeFile(join(work, 'new.txt'), 'n\n'); await commit(work, 'New branch work\n');
    await sh(work, ['checkout', '-q', 'main']);
    const nn = await pushCommits({ repo: work, branch: 'night/new', remote, api: fake() });
    assert.equal(nn.pushed, 1); assert.equal(await remoteHead('night/new'), await localHead('night/new'));
  });

  await test('a SHA mismatch stops before the branch moves', async () => {
    await writeFile(join(work, 'tz.txt'), 'tz\n'); await commit(work, 'Timezone sensitive\n');
    const before = await remoteHead();
    const f = createFakeGithub({ bare, remote, quirks: { dropTimezone: true } });
    await assert.rejects(pushCommits({ repo: work, branch: 'main', remote, api: f }), (e) => e.code === 'sha_mismatch' && /not moved/.test(e.message));
    assert.equal(await remoteHead(), before); assert.ok(!f.calls.some((c) => c.method === 'PATCH'));
  });

  await test('signed commits are refused before anything is sent', async () => {
    const head = await localHead();
    const raw = (await git(work, ['cat-file', 'commit', head])).replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n');
    const signed = (await git(work, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: raw })).trim();
    await git(work, ['branch', 'signed', signed]);
    const f = fake();
    await git(bare, ['update-ref', 'refs/heads/signed', await remoteHead()]);
    await assert.rejects(pushCommits({ repo: work, branch: 'signed', remote, api: f }), (e) => e.code === 'unsupported_commit' && /signed/.test(e.message));
    assert.equal(posts(f).length, 0);
  });

  // The real CLI adapter, against a fake "composio" executable that serves the same fake.
  const bin = join(dir, 'composio');
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./github-fake-composio.mjs', import.meta.url)))} "$@"\n`);
  await chmod(bin, 0o755);
  const env = (extra = {}) => ({ ...process.env, FAKE_BARE: bare, ...extra });

  await test('github_push through the composio CLI adapter, and owner steps', async () => {
    const tool = createGithubExtension({ cwd: dir, bin, env: env() }).tools.find((t) => t.name === 'github_push');
    assert.ok(Compile(tool.parameters).Check({ repoPath: 'work', branch: 'main', remote }));
    await writeFile(join(work, 'tz.txt'), 'cli\n'); await commit(work, 'Pushed through the CLI\n');
    await git(work, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const out = (await tool.execute({ repoPath: 'work' }, {}, {})).structuredOutput;
    assert.equal(out.status, 'pushed', JSON.stringify(out)); assert.equal(out.pushed, 2); assert.match(out.message, /Pushed 2 commits/);
    assert.equal(await remoteHead(), await localHead());
    assert.equal((await git(work, ['rev-parse', 'refs/remotes/origin/main'])).trim(), await localHead(), 'tracking ref updated');
    const again = await githubPush({ repoPath: work, branch: 'main', remote, bin, env: env({ FAKE_NO_STATUS: '1' }) });
    assert.equal(again.status, 'up_to_date');
    await writeFile(join(work, 'nostatus.txt'), 's\n'); await commit(work, 'No status line\n');
    assert.equal((await githubPush({ repoPath: work, branch: 'main', remote, bin, env: env({ FAKE_NO_STATUS: '1' }) })).pushed, 1);
    const missing = await githubPush({ repoPath: work, branch: 'main', remote, bin: null, env: env() });
    assert.equal(missing.status, 'needs_setup'); assert.match(missing.ownerSteps.join('\n'), /composio.dev\/install[\s\S]*composio login[\s\S]*link github/);
    const out2 = await githubPush({ repoPath: work, branch: 'main', remote, bin, env: env({ FAKE_COMPOSIO_MODE: 'logged_out' }) });
    assert.equal(out2.status, 'needs_setup'); assert.equal(out2.ownerSteps.length, 2);
    const out3 = await githubPush({ repoPath: work, branch: 'main', remote, bin, env: env({ FAKE_COMPOSIO_MODE: 'unlinked' }) });
    assert.equal(out3.status, 'needs_setup'); assert.match(out3.ownerSteps[0], /link github/);
  });
  console.log(`PASS github sync: ${passed} tests, SHAs identical through the Git Data API replay`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
