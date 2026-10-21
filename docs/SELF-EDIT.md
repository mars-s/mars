# Changing Mars itself

This spec covers how the Mars agent changes its own host code, so that a small model can
do it safely. It starts with an audit of the tools that existed on 22 October 2026, then
specifies the `self_edit_*` tools that close the gaps.

## Audit: the existing path, from the agent's side

The agent had `apply_patch`, `host_exec`, `host_deploy`, `host_deploy_status`, the
`ui_patch_*` tools and `install_extension`. A small model following HOST-GUIDE.md and the
tool descriptions would get these wrong.

1. **The checks that judge a change come from the change.** `host_deploy` stages the
   candidate commit and runs that commit's own `run-checks.mjs`, `check-*.mjs` and
   `deploy-watchdog.sh`. A change that edits a failing check, makes `run-checks.mjs`
   print `ok`, or weakens the rollback script passes its own gate. Nothing refused it.
2. **Edits land in the live checkout.** There was no isolated place to work. The model
   edits `MARS_REPO_ROOT` directly, which is the checkout that development Fast Refresh
   and the next deploy read. A half-finished edit is visible at once, and two edits at
   the same time share one working tree.
3. **Deploying needs a commit on a real branch first.** "Commit, then host_deploy" leaves
   the model to pick a branch and stage files itself. The usual mistake is `git add -A`,
   which also picks up untracked files, a `node_modules` symlink or a `.env` file.
4. **`apply_patch` resolves a relative `cwd` against the host process folder.** Its
   example says `cwd: "projects/site"`, like `host_exec`, but `host_exec` resolves against
   the workspace and `apply_patch` resolved against `process.cwd()`. In production that
   is the managed runtime `ROOT/app`, the one place the guide says never to hand-edit.
5. **No cheap check before the slow one.** The only gate was the full staging run (every
   check plus a test boot, about 40 s). Nothing ran `node --check` on the changed files
   or only the checks that cover them. A small model learns about a typo only after a
   full staging run, from a JSON summary with 1.5 KB log tails.
6. **Results say what happened, not what to do next.** `host_deploy` returned `next` only
   when a restart was scheduled. `dry_run` and `staging_failed` results left the model to
   work out the next step from `checks.failed[].log`.
7. **UI changes in a host commit are silently not shipped.** `host_deploy` copies only
   `packages/pi-host`. A commit that also changes `apps/ui` reports `ok`, and the UI part
   never reaches the owner.
8. **A deploy from a branch is undone by the next deploy from main.** Nothing told the
   model that a deployed commit must also be merged.
9. **An installed extension can replace built-in tools.** The native registry replaces
   an extension by name, and `ExtensionStore` reserves only the names `trial-host` and
   `recovery-probe`. An extension named `host-dev` would replace `host_deploy`. Its
   reserved tool list also omits `host_deploy`, `apply_patch` and `self_edit_*`, and two
   extensions may register the same tool name (the first installed wins). This audit
   records the gap; the fix belongs in `extension-store.mjs`, outside this change.
10. **`ui_patch_validate` needs Linux.** It runs inside `/usr/bin/bwrap`, so it fails on
    the owner's Mac (the known `check-ui-patches` failure). Its path allowlist covers
    `apps/ui` only, so it does not help with host changes.

What already works and is kept: staging never touches the live app, it boots the
candidate on a spare port, and the watchdog restores a backup if the restarted host is
unhealthy. `host_deploy_status` reads the outcome after the restart.

## The self-edit path

Four tools, used in this order, plus a list. Every result has a `next` field: one or two
plain sentences naming the next call.

| Tool | Does | Returns |
| --- | --- | --- |
| `self_edit_start { title }` | Creates a git worktree and branch from the checkout's current commit | `id`, `worktree`, `branch`, `base`, `next` |
| `self_edit_check { id, scope? }` | Runs the trust-boundary guard, syntax, the names and imports check, and the host checks that cover the changed files | `ok`, `changed`, `failed`, `untested`, `next` |
| `self_edit_finish { id, deploy?, message? }` | Guards, checks, commits, then runs `host_deploy` for that exact commit | `status`, `commit`, `deployId`, `failed`, `next` |
| `self_edit_abandon { id }` | Removes the worktree and its branch | `abandoned`, `next` |
| `self_edit_list {}` | Lists sessions and their state | `sessions`, `next` |

### Start

- The worktree lives at `<dir>/<id>`. `dir` defaults to `MARS_PI_ROOT/self-edits`, and
  `MARS_SELF_EDIT_DIR` overrides it. The branch is `self-edit/<id>`. The id is the title
  as a slug plus four random hex characters.
- `base` is the full commit SHA of the checkout's `HEAD`. The session record, with
  `base`, is written to `MARS_PI_ROOT/data/self-edits/<id>.json`, outside the worktree.
- The worktree gets a `node_modules` symlink to the installed dependencies, so checks and
  imports run as they do in the checkout. The symlink is never committed.
- The live checkout is not changed: its files, `HEAD`, branch and index stay as they
  were. A title with no letters or digits is refused.

### Check

`self_edit_check` stages every change in the worktree into its own index and compares
that index with `base`. That covers commits made in the worktree and uncommitted edits
alike. Then, in order, stopping at the first failing step:

1. **Guard.** The trust boundary below. A refusal lists each file and why.
2. **Syntax.** `node --check` on each changed `.mjs`, `.js` or `.cjs` file, and
   `JSON.parse` on each changed `.json` file.
3. **Names and imports.** `tsc --checkJs` over `packages/pi-host`, keeping only the error
   codes for an unknown name, a missing module, a missing export and a duplicate
   declaration (see "Type check experiment"). Skipped with a note when TypeScript is not
   installed.
4. **Host checks.** Each `check-*.mjs` whose relative imports reach a changed host file
   (`import ... from './x.mjs'`, `import('./x.mjs')` and `new URL('./x', import.meta.url)`,
   which covers checks that boot `server.mjs`), plus any changed or added check file. A
   change to a `package.json`, `package-lock.json` or non-module host file runs every
   check, and so does `scope: "all"`. Checks run through the worktree's `run-checks.mjs`
   with a new temporary `MARS_PI_ROOT`, never the live data root.

`untested` lists changed host modules that no check reaches, so the model knows to add a
check or use `scope: "all"`. Changes outside `packages/pi-host` are listed in
`notDeployed`, because `host_deploy` does not ship them.

### Finish

1. Guard and check, as above. A refusal or failure returns `status: "refused"` or
   `"check_failed"` and commits nothing.
2. Commit the staged changes on the branch with `message` (default: the title). If there
   is nothing new to commit but the branch is ahead of `base`, finish uses the branch
   head, so calling finish again is safe. If the branch equals `base`, it returns
   `status: "nothing_to_finish"`.
3. `deploy` decides what follows:
   - `"none"`: stop after the commit (`status: "committed"`).
   - `"dry_run"` (default): `host_deploy { ref: <commit>, dryRun: true }`. Returns
     `"dry_run_passed"`, or `"staging_failed"` with the failed check files.
   - `"deploy"`: allowed only after a passed dry run of the same commit in this session,
     otherwise `status: "dry_run_required"`. Then `host_deploy { ref: <commit> }`, which
     keeps the staged checks and the watchdog rollback. Returns `"scheduled"` with the
     deploy id for `host_deploy_status`.
4. Deploying calls the existing `createDevTools().deploy`. Self-edit does not stage,
   restart or roll back anything itself.

After a deploy the commit is live but only on the `self-edit/<id>` branch. `next` tells
the model to merge it into the checkout's branch or ask the owner, because the next
deploy from `main` would otherwise undo it.

### Abandon

Removes the worktree, deletes its branch and marks the session abandoned. Calling it
again is a no-op. After a real deploy it keeps the branch, because the live host runs
that commit.

## Trust boundary

A self-edit may not change the files that decide whether a self-edit is acceptable. The
guard runs in `self_edit_check` and again in `self_edit_finish`, on
`git diff --cached --name-status --no-renames <base>`, so a rename shows as a delete plus
an add and both are judged.

Protected paths (any change, including a delete, a mode change or replacement by a
symlink):

| Path | Why |
| --- | --- |
| `packages/pi-host/run-checks.mjs` | Runs the checks and decides pass or fail |
| `packages/pi-host/deploy-watchdog.sh` | Applies a deploy and rolls back an unhealthy host |
| `packages/pi-host/dev-tools.mjs` | The deploy gate: staging, checks and the test boot |
| `packages/pi-host/self-edit.mjs` | This guard |
| `packages/pi-host/tool-quality.mjs` | The tool-quality rules |
| `packages/pi-host/security.mjs` | Owner authentication, origins and data roots |
| `packages/pi-host/extension-store.mjs` | Which extensions and tool names may be installed |
| `packages/pi-host/ui-patches.mjs` | The UI patch validation gate |
| `packages/pi-host/workbench/test-host.mjs` | The test host many checks share |
| `packages/pi-host/tsconfig.json` | The names and imports check settings |
| `scripts/check-*.mjs`, `scripts/test-*.mjs`, `scripts/run-script-tests.mjs` | Root gates and their tests |
| `architecture-policy.json` | The workspace boundary rules |
| `AGENTS.md`, `.agents/DECISIONS.md`, `.agents/verification.md`, `docs/SELF-EDIT.md` | The rules and this spec |
| `.gitignore`, `.github/` | What may be committed, and CI |

Existing check files, meaning every `packages/pi-host/check-*.mjs` present at `base`, are
protected too: a self-edit may not edit or delete them. It may add a new check file, which
then runs with the others and can only add failures.

Never committed, whatever the path: `node_modules`, `.env` and `.env.*` (except
`.env.example`), and `*.sqlite`, `*.db` and their `-wal` and `-shm` files.

A refusal returns each file with its reason, and a `next` that says how to undo it:
`git -C <worktree> checkout <base> -- <path>` for a changed file, or delete an added one.
The owner changes protected files directly, outside the self-edit tools.

This boundary stops the agent weakening its own gates through the self-edit path. It is
not a sandbox. The agent keeps full owner-authorised shell access, so `host_exec` can
still edit any file and `host_deploy` can still deploy any commit, the same trust model
as the UI patch interface. The session record holds `base` outside the worktree, so
editing the worktree cannot move it.

## Type check experiment

`tsc --checkJs --noEmit` over `packages/pi-host` (allowJs, strict off, skipLibCheck,
module nodenext, `types: ["node"]`, TypeScript 6.0.3) on commit `59a3d13`:

- 329 errors in 4.0 s across 41 files: 216 in `check-*.mjs` and 113 in host modules.
- A seeded random sample of 20 was all noise. Examples: default parameters without JSDoc
  narrowing an options object (`'cwd' does not exist in type '{ timeoutMs?: number; }'`),
  SDK types the host does not follow (`marsPlugin`, `ToolExecutionResult<JsonValue>`),
  `Error.code`, and a test helper typed from its first call.
- Two that looked real were checked by hand. `configure(tx, id, change, ctx)` passes an
  extra argument the SDK ignores, and the `trial.recovery` task commits
  `status: "pending"`, which the SDK types do not list but its scheduler accepts. Neither
  changes behaviour.
- Error codes for an unknown name, a missing module, a missing export or a duplicate
  declaration (TS2300, TS2304, TS2305, TS2307, TS2393, TS2451, TS2552, TS2614, TS2724): 0
  on the current code. A planted unknown helper name and a planted missing named import
  were both caught, and `node --check` passes both.

Decision: keep it, filtered to those codes. The full check is noise. The filtered check
has no false positives on the current code and catches the mistakes small models make
most often (a misremembered export or helper name), including in branches the checks do
not reach. It runs as step 3 of `self_edit_check`, and on demand with
`npm run typecheck:names --workspace @mars/pi-host`. It is not added to `run-checks.mjs`,
because staging installs only the host workspace, which does not include TypeScript.

## Verification

`packages/pi-host/check-self-edit.mjs` runs under `run-checks.mjs` with temporary
directories, a fixture repository and an injected deploy function. It never restarts a
service. It proves that:

- start, edit, check, finish and abandon leave the live checkout unchanged;
- protected and never-committed files are refused, and nothing is committed;
- a failing related check is reported by file name with a next action, and an unrelated
  check is not run;
- abandon removes the worktree and the branch;
- finish calls deploy with the exact commit and `dryRun: true`, and refuses a real
  deploy before a passed dry run.
