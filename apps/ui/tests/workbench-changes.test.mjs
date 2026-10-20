import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch } from "../components/ai/tool-adapter.ts";
import { changeBar, changeRows, repoLabel, totals } from "../components/workbench/changes-model.ts";
import { parseChanges, parseRepos } from "../lib/pi/workbench.ts";

// Shape produced by the host: `git diff HEAD` then one `--no-index` patch per untracked file.
const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 814f4a4..7a002a8 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  "+three",
  "diff --git a/old.md b/old.md",
  "deleted file mode 100644",
  "index 286c5f5..0000000",
  "--- a/old.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/logo.png b/logo.png",
  "index 7a002a8..88768ef 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/notes/todo list.md b/notes/todo list.md",
  "new file mode 100644",
  "index 0000000..8ff1852",
  "--- /dev/null",
  "+++ b/notes/todo list.md\t",
  "@@ -0,0 +1,2 @@",
  "+u1",
  "+u2",
  "",
].join("\n");

const changes = parseChanges({
  repo: "app",
  branch: "main",
  truncated: false,
  patch,
  files: [
    { path: "logo.png", status: "M", added: 0, removed: 0, binary: true },
    { path: "notes/todo list.md", status: "?", added: 2, removed: 0, binary: false },
    { path: "old.md", status: "D", added: 0, removed: 1, binary: false },
    { path: "src/app.ts", status: "M", added: 2, removed: 1, binary: false },
    { path: "vendor/huge.js", status: "A", added: 90000, removed: 0, binary: false },
  ],
});

test("every host file becomes a row joined to its own diff", () => {
  const rows = changeRows(changes, parsePatch(changes.patch));
  assert.deepEqual(
    rows.map((row) => [row.path, row.kind, row.dir, row.name, row.diff?.lines.length ?? null]),
    [
      ["logo.png", "modified", "", "logo.png", null],
      ["notes/todo list.md", "untracked", "notes/", "todo list.md", 2],
      ["old.md", "deleted", "", "old.md", 1],
      ["src/app.ts", "modified", "src/", "app.ts", 4],
      ["vendor/huge.js", "added", "vendor/", "huge.js", null],
    ],
  );
  const app = rows.find((row) => row.path === "src/app.ts");
  assert.deepEqual(app.diff.lines.map((line) => line.type), ["context", "remove", "add", "add"]);
});

test("totals come from the host counts, including files whose patch was cut", () => {
  const rows = changeRows(changes, parsePatch(changes.patch));
  assert.deepEqual(totals(rows), { added: 90004, removed: 2 });
});

test("a binary file never gets a text diff even if one is parsed for its path", () => {
  const rows = changeRows(changes, [{ path: "logo.png", lines: [{ type: "add", content: "x" }], added: 1, removed: 0 }]);
  assert.equal(rows[0].binary, true);
  assert.equal(rows[0].diff, undefined);
});

test("unknown statuses fall back to modified; the five-block bar splits by share", () => {
  const rows = changeRows(parseChanges({ files: [{ path: "x", status: "Z" }] }), []);
  assert.equal(rows[0].kind, "modified");
  assert.equal(changeBar(0, 0), 0);
  assert.equal(changeBar(3, 0), 5);
  assert.equal(changeBar(2, 1), 3);
  assert.equal(changeBar(0, 4), 0);
});

test("repos keep the workspace root as an empty path with a readable label", () => {
  const repos = parseRepos({ repos: [{ path: "", branch: "main", ahead: 2, behind: 1, dirty: true }, { branch: "x" }] });
  assert.deepEqual(repos, [{ path: "", branch: "main", ahead: 2, behind: 1, dirty: true }]);
  assert.equal(repoLabel(""), "Workspace root");
  assert.equal(repoLabel("group/lib"), "group/lib");
});
