// Lanes (docs/LANES.md), after the first live use: tool results match their schemas when Pi
// passes a numeric conversation id, two processes share the lanes file without undoing each
// other, and dismissing a merged lane hides it. Temporary git repository and data root only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { createLanes, createLanesExtension } from './lanes.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-lanes-shared-'));
const repo = join(dir, 'repo'), root = join(dir, 'root');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
await mkdir(repo, { recursive: true });
git(dir, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'check@example.com');
git(repo, 'config', 'user.name', 'Check');
await writeFile(join(repo, 'notes.txt'), 'one\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const make = () => createLanes({ repo, root, dir: join(dir, 'lanes'), previews: false, env: { ...process.env, MARS_PUBLIC_ORIGIN: '' } });
const lanes = make();
const passed = [];
try {
  const extension = createLanesExtension(lanes);
  const schema = (name) => Compile(extension.tools.find((t) => t.name === name).structuredOutputSchema);
  const matches = (name, value) => assert.ok(schema(name).Check(value), name + ' result matches its schema: ' + JSON.stringify([...schema(name).Errors(value)][0] ?? {}));
  const a = await lanes.start({ title: 'Lane A' }, 2367);
  assert.equal(a.conversationId, '2367', 'numeric ids become strings');
  matches('lane_start', a);
  matches('lane_list', await lanes.list());
  passed.push('results match tool schemas');

  const other = make();
  const x = await other.start({ title: 'Lane X' });
  assert.ok((await lanes.list()).lanes.some((l) => l.id === x.id), 'a lane started elsewhere is listed');
  await writeFile(join(a.worktree, 'a.txt'), 'a\n');
  const merged = await lanes.submit({ id: a.id, message: 'A' });
  assert.equal(merged.state, 'merged', merged.next);
  matches('lane_submit', merged);
  assert.ok((await other.list()).lanes.some((l) => l.id === a.id && l.state === 'merged'), 'the other process sees the merge');
  assert.ok((await lanes.list()).lanes.some((l) => l.id === x.id), 'the merge did not drop the other lane');
  passed.push('shared between processes');

  const dismissed = await other.close({ id: a.id });
  matches('lane_close', dismissed);
  assert.equal(dismissed.state, 'closed');
  assert.equal((await lanes.list()).lanes.some((l) => l.id === a.id), false, 'a dismissed merged lane is hidden');
  await lanes.close({ id: x.id });
  passed.push('dismiss hides merged lanes');
  console.log('PASS lanes shared: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
