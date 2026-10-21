# Verification

Use pinned Node24.14.0 and the single npm workspace lock. Read docs/INSTALL.md for
actual install/start commands and docs/MIGRATION-RESULTS.md for this cutover.

Run root typecheck, lint, architecture:check, tests, browser fixtures and build.
Native checks use isolated databases and deterministic providers. A fresh-install
check must use a new temporary MARS_PI_ROOT and must make no real model calls.
The separate live check reads an owner token privately and compares native
history/model/plugin state, never logs secrets or creates paid model traffic.

Do not substitute historical ZCode/DeepSeek checks or old demo test totals for
current results. Browser fixtures do not prove real provider access. Mac execution
is separate from checks run on Debian Bot Box. Disabled old services and cold
backup data are not active dependencies.

## Workbench (docs/WORKBENCH.md)

From `apps/ui`, against a running preview (`MARS_UI_BASE_URL`, fixture on 3191):
`npx tsc --noEmit`, `npx eslint app components lib`, `npm test` (unit), then
`workbench-ui-check`, `workbench-files-check`, `workbench-changes-check`,
`workbench-pages-check`, `workbench-terminal-check`, `workbench-browser-check`
(all call `waitForHydration` before clicking), then the production build.
From `packages/pi-host`: `run-checks.mjs --json` runs every `check-*.mjs`, including
`check-workbench-{core,files,changes,pages,terminal,browser,races}.mjs` on a real host
with a temporary `MARS_PI_ROOT` and no model calls. `check-workbench-races.mjs` runs
for `MARS_RACE_SECONDS` (default 3) per race.

These are fixture and temporary-host proofs. They do not prove a live Bot Box run,
real provider traffic or a real user's dev server behind the Browser pane. Known
Mac-only failures that predate this work: check-dev-tools, check-ui-patches,
check-vm-control, and the flock installer tests.
