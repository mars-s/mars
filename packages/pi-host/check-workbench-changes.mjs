import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChanges, PATCH_CAP, UNTRACKED_CAP } from "./workbench/changes.mjs";
import { startHost } from "./workbench/test-host.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Check", "-c", "user.email=check@mars.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
async function repo(dir, files) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
}

// git missing is reported, not assumed.
{
  const saved = process.env.PATH;
  process.env.PATH = await mkdtemp(join(tmpdir(), "mars-nogit-"));
  const missing = await createChanges({ work: tmpdir() }).available();
  process.env.PATH = saved;
  assert.deepEqual(missing, { ok: false, reason: "git was not found on the host." });
}

const outside = await mkdtemp(join(tmpdir(), "mars-outside-repo-"));
await repo(outside, { "secret.txt": "outside\n" });
const proof = await mkdtemp(join(tmpdir(), "mars-filter-proof-"));

const host = await startHost();
try {
  const { work, request } = host;
  await mkdir(work, { recursive: true });
  assert.equal((await request("/api/workbench/repos", { auth: false })).status, 401, "repos needs owner auth");
  assert.equal((await request("/api/workbench/changes?repo=app", { auth: false })).status, 401, "changes needs owner auth");
  const caps = await request("/api/workbench/capabilities");
  assert.deepEqual(caps.json.tools.changes, { available: true }, "git present makes Changes available");

  const app = join(work, "app");
  await repo(app, { "modified.txt": "one\ntwo\n", "deleted.txt": "gone\n", "image.bin": Buffer.from([0, 1, 2, 3]) });
  await writeFile(join(app, "modified.txt"), "one\nTWO\nthree\n");
  await rm(join(app, "deleted.txt"));
  await writeFile(join(app, "added.txt"), "fresh\n");
  git(app, "add", "added.txt");
  await writeFile(join(app, "untracked notes.md"), "a\nb\nc\n");
  await writeFile(join(app, "image.bin"), Buffer.from([0, 9, 9, 9, 0]));
  await writeFile(join(app, "blob.dat"), Buffer.from([0, 0, 7]));
  // A repo-configured clean filter must never run.
  await writeFile(join(app, ".git/info/attributes"), "*.txt filter=evil\n");
  git(app, "config", "filter.evil.clean", `sh -c 'touch "${proof}/ran"; cat'`);
  git(app, "config", "filter.evil.required", "true");

  await repo(join(work, "group/lib"), { "a.md": "a\n" });
  await repo(join(work, "a/b/c/d"), { "x.md": "x\n" });
  await repo(join(work, "node_modules/pkg"), { "x.md": "x\n" });
  await symlink(outside, join(work, "escape"));

  const repos = await request("/api/workbench/repos");
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.json.repos.map((row) => row.path), ["app", "group/lib"], "depth 3, node_modules skipped, escaping symlink not followed");
  const appRow = repos.json.repos.find((row) => row.path === "app");
  assert.deepEqual(appRow, { path: "app", branch: "main", ahead: 0, behind: 0, dirty: true });
  assert.equal(repos.json.repos.find((row) => row.path === "group/lib").dirty, false);

  for (const bad of ["../x", "app/../../x", "/etc", "escape"]) {
    const res = await request(`/api/workbench/changes?repo=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 403, `repo ${bad} outside the workspace is refused`);
  }
  assert.equal((await request("/api/workbench/changes?repo=group")).status, 404, "a plain folder is not a repo");

  const res = await request("/api/workbench/changes?repo=app");
  assert.equal(res.status, 200, res.text);
  const { json } = res;
  assert.equal(json.repo, "app");
  assert.equal(json.branch, "main");
  assert.equal(json.truncated, false);
  const byPath = Object.fromEntries(json.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath["modified.txt"], { path: "modified.txt", status: "M", added: 2, removed: 1, binary: false });
  assert.deepEqual(byPath["added.txt"], { path: "added.txt", status: "A", added: 1, removed: 0, binary: false });
  assert.deepEqual(byPath["deleted.txt"], { path: "deleted.txt", status: "D", added: 0, removed: 1, binary: false });
  assert.deepEqual(byPath["untracked notes.md"], { path: "untracked notes.md", status: "?", added: 3, removed: 0, binary: false });
  assert.deepEqual(byPath["image.bin"], { path: "image.bin", status: "M", added: 0, removed: 0, binary: true }, "tracked binary flagged");
  assert.deepEqual(byPath["blob.dat"], { path: "blob.dat", status: "?", added: 0, removed: 0, binary: true }, "untracked binary flagged");
  assert.equal(json.files.length, 6);
  for (const marker of ["+++ b/modified.txt", "+TWO", "-two", "+++ b/added.txt", "--- a/deleted.txt", "+++ b/untracked notes.md", "+c", "Binary files"])
    assert.ok(json.patch.includes(marker), `patch includes ${marker}`);
  assert.deepEqual(await readdir(proof), [], "repo-configured filter did not run");

  // A repository with no commits yet diffs against the empty tree.
  const fresh = join(work, "fresh");
  await mkdir(fresh);
  git(fresh, "init", "-q");
  await writeFile(join(fresh, "first.md"), "hello\n");
  git(fresh, "add", "first.md");
  const initial = await request("/api/workbench/changes?repo=fresh");
  assert.equal(initial.status, 200, initial.text);
  assert.deepEqual(initial.json.files, [{ path: "first.md", status: "A", added: 1, removed: 0, binary: false }]);

  // Caps: patch at 1 MiB, untracked files at 50.
  const big = join(work, "big");
  await repo(big, { "keep.txt": "k\n" });
  await writeFile(join(big, "huge.txt"), "x".repeat(99) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(12000));
  git(big, "add", "huge.txt");
  for (let n = 0; n < UNTRACKED_CAP + 5; n++) await writeFile(join(big, `u${String(n).padStart(2, "0")}.txt`), `${n}\n`);
  const capped = await request("/api/workbench/changes?repo=big");
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.json.truncated, true, "over-cap change set is flagged");
  assert.ok(Buffer.byteLength(capped.json.patch) <= PATCH_CAP, "patch stays within 1 MiB");
  assert.ok(capped.json.patch.startsWith("diff --git a/huge.txt"), "patch keeps whole lines from the start");
  assert.equal(capped.json.files.filter((file) => file.status === "?").length, UNTRACKED_CAP, "untracked files capped at 50");
  assert.equal(capped.json.files.find((file) => file.path === "huge.txt").added, 12001, "counts stay exact when the patch is cut");
} finally {
  await host.stop();
}
console.log("PASS workbench changes: owner auth, git-missing reason, repo discovery depth 3, workspace and symlink escape refused, modified/added/deleted/untracked counts, binary flagged, initial commit, repo filters disabled, 1 MiB patch and 50 untracked caps");
