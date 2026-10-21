# Lane: changes

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/wb-changes`, branch `codex/wb-changes`, UI port **3232**.
Contract: docs/WORKBENCH.md "Changes". Host module `packages/pi-host/workbench/changes.mjs`,
check `check-workbench-changes.mjs`. Pane `apps/ui/components/workbench/changes-pane.tsx`
(+ css), browser check `apps/ui/tests/workbench-changes-check.mjs`.

Build: repo picker (from `/api/workbench/repos`, git repos at or under the workspace,
depth 3), branch and ahead/behind, then the change set rendered with the vendored
Kokonut Diff Review shell look (file list with +/- and status) and each file's diff
with the 21st `EditToolDiffCard` / `@pierre/diffs` inside `DiffHighlighterReady`
(see `components/ai/tool-adapter.ts` `parsePatch` and `components/activity/*` for how
patches already become cards). Read-only: no accept/reject actions. Refresh button.
Host: `git` via `execFile` with `-c core.pager=cat -c diff.external= -c core.hooksPath=/dev/null`,
`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, 10 s timeout, patch capped 1 MiB with
`truncated`, untracked text files shown as additions (use `git diff --no-index /dev/null <file>`
per untracked file, capped at 50 files). `available()` reports "git was not found" when
missing. Check: 401, repo outside workspace refused, a temp repo with a modified,
added, deleted and untracked file returns all four with correct counts, a binary
file is flagged, cap works.
