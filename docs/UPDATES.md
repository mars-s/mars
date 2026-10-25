# Updating Mars from main

Mars updates itself from the `main` branch on GitHub. An ordinary update (new commits on
main, nothing local in the way) needs no model and no judgement. The updater fetches,
builds the new version beside the running one, swaps it in, restarts and checks health.
If the new version is unhealthy it puts the old one back. Only a real conflict between
local commits and main needs a person or the agent, and that path is opt-in.

This is modelled on the Hermes Agent source-checkout updater (`hermes update` and the
desktop Update control). I read its docs and `hermes_cli/update_*` and
`apps/desktop/src/store/updates.ts` on 22 October 2026. Kept from Hermes: fetch only the
tracked branch; count commits behind; build the new app on the side and swap it in, so a
failed build leaves the old one running; stop the services before the checkout moves; a
journal so an update killed half way is undone on the next start; a background check and
an "update available" notice. Changed for Mars: Hermes autostashes local edits and, on a
diverged checkout, saves a rescue ref and runs `git reset --hard`. Mars never stashes or
resets. On the server, local commits are usually merged self-edits, so a diverged
checkout is merged, and a merge that would conflict stops and names the files.

## Words

- **Checkout**: the Git checkout the services run from (`MARS_REPO_ROOT`).
- **Target**: the commit at `origin/main` after the latest fetch.
- **Result**: the commit the checkout will be on after the update. The target for a
  fast-forward, a new merge commit when both sides moved, or a reconcile commit.
- **Installed**: what runs. The checkout, `apps/ui/.next-build`, the root `node_modules`
  and the host runtime copy in `MARS_PI_ROOT/app`.

## Check

`npm run update -- check`, and the host every 6 hours (`MARS_UPDATE_CHECK_HOURS`, `0`
turns it off; the first check is 2 minutes after start), runs:

1. `git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main` with prompts
   off and a 60 second limit. `MARS_UPDATE_REMOTE` and `MARS_UPDATE_BRANCH` change the
   names.
2. Facts: current branch, HEAD, target, merge base, whether a merge, rebase,
   cherry-pick, revert or bisect is in progress, uncommitted paths, the paths the update
   changes and, when both sides moved, a `git merge-tree` dry merge.
3. One pure function turns the facts into a state:

| State | Meaning | Update does |
| --- | --- | --- |
| `up_to_date` | HEAD is the target | nothing |
| `ahead` | main has nothing new; this copy has commits main lacks | nothing |
| `fast_forward` | main has new commits; this copy has none of its own | moves to the target |
| `merge` | both moved and Git merges them cleanly, or a finished reconcile exists | makes or uses a merge commit and moves to it |
| `needs_reconcile` | both moved and they change the same lines | refuses; see Reconcile |
| `blocked` | something must be fixed first | refuses |

Blockers, each with a plain sentence and, where it applies, the files:

- `not_git`: the checkout is not a Git repository.
- `no_remote`: the fetch failed or the branch does not exist, with Git's reason.
- `wrong_branch` or `detached`: the checkout is not on the tracked branch.
- `operation_in_progress`: finish or abort the merge or rebase first.
- `local_changes_overlap`: uncommitted changes touch files the update changes. Commit
  them (then they are merged) or discard them. Uncommitted changes to other files are
  kept, and they are part of the new build.
- `untracked_overwritten`: an untracked file has the same path as a file the update adds.
- `deploy_in_progress`: a `host_deploy` is scheduled or applying.

The result goes to `MARS_PI_ROOT/updates/status.json`: the state, counts behind and
ahead, up to 20 new commit subjects, blockers and the time. A check never changes the
checkout or anything that runs. Its only write to the repository is the fetch.

## Update

`npm run update -- apply`, Settings, Updates, "Update now", and the agent's
`mars_update_apply` run the same code. One update runs at a time. `updates/.lock` holds
the owner's process id, its boot time and a random nonce, and is published whole with
`link()`. A lock whose process has died, or which came from an earlier boot, is taken
over by the one process that first creates `updates/.takeover-<nonce>`. Apply first
settles any update the journal says was interrupted (below).

### Prepare (nothing live changes)

1. Check again. Refuse unless the state is `fast_forward` or `merge`.
2. For a clean merge, write the merge commit with `git merge-tree --write-tree` and
   `git commit-tree` (parents HEAD and target). The checkout's files, index and branch
   are not touched. Committer name `Mars updater` when Git has no identity configured.
3. Unpack the result with `git archive` into `MARS_PI_ROOT/updates/<id>/tree`, then copy
   the checkout's uncommitted files over it. The tree is then exactly what the checkout
   will hold afterwards.
4. Dependencies: if the root `package-lock.json` and every workspace manifest's
   dependency fields are unchanged, link the installed `node_modules`. Otherwise run
   `npm ci` in the tree.
5. Syntax: `node --check` on every `.mjs` in `scripts` and `packages/pi-host`.
6. Build the UI: `next build --webpack` in the tree into `apps/ui/.next-build`. A Next
   build made in one folder and moved to another still serves. I tested this on
   22 October 2026: `/` and `/design-system` returned 200 from a moved build whose
   original folder no longer existed.
7. Host runtime: copy the tree's `packages/pi-host` to `updates/<id>/app`, keep the files
   only the live runtime has (as `host_deploy` does) and write the root lock as
   `.workspace-lock.json`.
8. Test boot: start that runtime on a free loopback port with a new temporary data root
   (`MARS_PI_STAGING=1`, so no chat clients start) and require `GET /api/state` 200.
9. `full` (CLI `--full`) also runs every host check with `run-checks.mjs`, as a staging
   host on the new tree (`MARS_PI_STAGING=1`, `MARS_REPO_ROOT` the tree).
10. Stage: move the new `node_modules` (when it changed), the new `.next-build` and the new
    runtime next to the parts they replace, as `<part>.incoming-<id>`. Any copying across
    disks happens here, while nothing live has changed.
11. Verify: the checkout must still be on the tracked branch at the commit the update
    started from. A commit made during the build stops the update here.

Any failure ends the update as `failed`, with the step and the end of its output.
Nothing live has changed.

### Switch over

The journal `updates/current.json` records each step before and after it runs.

1. Stop the UI and host services (`systemctl --user stop`).
2. Verify the checkout again, then move it: `git merge --ff-only <result>`. Git refuses if
   an uncommitted file would be overwritten.
3. For `node_modules` (when it changed), `apps/ui/.next-build` and `MARS_PI_ROOT/app`:
   rename the live part to `<part>.prev-<id>`, then `<part>.incoming-<id>` to the live
   name. Same folder, so these are renames, never copies.
4. Start both services. Wait up to 90 seconds (`MARS_UPDATE_HEALTH_SECONDS`) for the
   host's `GET /api/state` and the UI through the host's `GET /` to answer 200 with the
   owner token.

Healthy: the journal records `committed` first. From then on the update is finished
forwards, never undone: the `.prev` copies are deleted and `updates/installed.json`
records the commit (`updated`). Unhealthy: undo in reverse. Each `.prev` part goes back.
The checkout is reset (`git reset --keep <old HEAD>`, which keeps uncommitted work) only
when it is still on the tracked branch at this update's result; anything else is left
alone and reported. Then start the services again and check health. The outcome is
`rolled_back`, or `rollback_failed` with both reasons. The last three update folders are
kept for their logs.

Automatic installs do not retry a target whose last attempt failed or rolled back. A
newer commit on main is tried.

### When the updater is interrupted

From the host, the update runs as a transient `systemd-run --user` unit, outside the
services it stops. It loads all of its code before the checkout moves. If it dies during
the switch-over (power loss, `kill -9`), the journal still says `switching`, or
`committed` after a healthy start. Three things settle it, under the lock:

- The unit's `ExecStopPost` runs `npm run update -- recover --restart` when the updater
  stops for any reason. With nothing pending it does nothing; otherwise it stops the
  services, settles the update, starts them and checks health. So Mars does not stay
  down if the updater dies between stop and start.
- `scripts/run.mjs` settles it before either role starts (after a reboot).
- `npm run update -- apply` settles it before anything else.

Settling a `committed` update finishes it forwards (`updated`). Settling a `switching`
update undoes it (`interrupted`). A live update holding the lock is left alone.
`npm run update -- recover` does the same by hand. An interrupted prepare needs no undo,
since nothing live changed: recovery records it as `failed` ("Interrupted while preparing")
and removes the `*.incoming-<id>` folders it built beside the live copy. A checkout step
that failed (a commit landed while the services stopped) moved nothing, so undo leaves the
checkout alone. Settings shows an update as running from the moment it holds the lock,
before its journal is written.

`npm run update -- apply` run from inside the host service (for example through
`host_exec`) is refused on Linux, because stopping the host would kill it. Use
`mars_update_apply`.

### Without systemd services

On a Mac, or when Mars was started with `npm run dev` or `npm start`, the updater cannot
restart Mars. If the host or UI port answers, it refuses: "Stop Mars, then run
`npm run update -- apply`". Otherwise it switches over without starting anything and
reports `updated` with `restarted: false`. Settings and the agent tool say this and
offer the command instead of the button.

## Reconcile (the second path, opt-in)

When the state is `needs_reconcile`, nothing happens by itself. The owner can merge by
hand in the checkout (`git merge origin/main`), or ask Mars:

1. `mars_update_reconcile_start` makes a worktree at `MARS_PI_ROOT/updates/reconcile` on
   branch `update/reconcile` from HEAD and runs `git merge --no-commit <target>` there.
   It returns the conflicted files. An earlier reconcile worktree is replaced.
2. The agent edits those files in the worktree.
3. `mars_update_reconcile_finish` stages everything and compares whole trees (so renames
   and deletes count). It refuses unmerged paths, conflict markers, a never-commit file,
   a syntax error in a changed `.mjs`, and a protected file (`protected-files.mjs`) that
   matches neither side: the agent may keep this copy's version or main's whole, never
   edit, rename or delete it. Then it commits the merge. Apply runs the same tree check
   on the reconcile commit again before installing it.
4. The next check reports `merge` with `reconciled: true`, as long as the commit's
   parents are still HEAD and the current target. `mars_update_apply` installs it.

## Interfaces

- CLI: `npm run update -- status | check | apply [--full] | recover | reconcile-start |
  reconcile-finish`, with `--json` for machine output.
- Host HTTP, owner authenticated: `GET /api/update`, `POST /api/update/check`,
  `POST /api/update/apply`, `POST /api/update/settings` (`{ auto }`). `/api/state`
  carries `update: { state, behind }` for the sidebar notice.
- Agent tools: `mars_update_status`, `mars_update_apply`, `mars_update_reconcile_start`,
  `mars_update_reconcile_finish`. Every result has `next`.
- Settings, Updates: the installed commit, last check, new commits, blockers in plain
  words, Check now, Update now, progress by step, the last result and "Install updates
  automatically".
- Automatic install, off by default: after a background check finds `fast_forward` or
  `merge` and no conversation is running, the host starts the update. Never for
  `needs_reconcile` or `blocked`.

## Trust boundary

`scripts/update.mjs`, `scripts/update-check.mjs`, `scripts/run.mjs`,
`packages/pi-host/updates.mjs` and this file are protected files
(`protected-files.mjs`). A self-edit or the agent's `host_deploy` cannot change them, and
a reconcile may only keep one side of them whole. Updates themselves come from main,
which the owner controls.

## Tests

- `scripts/test-update.mjs` (in `npm test`, 32 cases): real temporary Git repositories
  with fake services, npm, build, test boot and health. Every state and blocker
  (including a staged rename and an ignored file in the way), clean and
  dependency-changing fast-forwards, a clean merge, a conflict, uncommitted work kept in
  the build, a commit made during the build, failed build, syntax, boot and checks,
  rollback with a healthy and an unhealthy old version, a failed service start, undo
  leaving a later commit alone, the lock (busy, dead holder, earlier boot, six processes
  racing to recover), the no-systemd paths, `kill -9` before the runtime swap and after
  a healthy start, and reconcile (markers, mixed, renamed and deleted protected files,
  and a hand-made reconcile commit that drops a gate).
- `packages/pi-host/check-updates.mjs`: the real host's owner routes, the badge, settings,
  refusal in staging and outside systemd, the four tools including reconcile, the
  `systemd-run` launch with its recover fallback (fake `systemd-run`), and no automatic
  retry of a rolled-back target.
- `apps/ui/tests/updates.test.mjs` and `updates-ui-check.mjs`: parsing, and Settings,
  Updates against the preview fixture at 1440px dark and 390px light.

Not covered by automated tests: a real `systemctl` restart and `ExecStopPost`, a real
`npm ci` and Next build inside the updater, and GitHub itself. The relocated Next build
was checked by hand (see Prepare, step 6). The lock takeover is checked by a six-process
race and by reading; the narrow window where a slow taker sees an old dead lock after a
new owner has taken it is guarded by the takeover marker, not by a test that reliably
hits that window.

## Not done here

- The updater does not push merge commits to GitHub. The owner pushes.
- No release channels. Main only.
- The restart interrupts running conversations, as `host_deploy` does. Pi resumes them
  and the gateway delivers once (`check-gateway-host.mjs`). There is no drain.
