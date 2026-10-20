# Workbench tool lanes: shared brief

You build one workbench tool for Mars, end to end: host route(s), real-host check,
preview-fixture support, UI pane, unit tests, browser check, screenshots. Read in
full first: `docs/WORKBENCH.md` (the contract; follow it exactly), `AGENTS.md`,
`apps/ui/DESIGN.md`, `.agents/lanes/COMMON.md` (how to run and verify; still
applies), `/Users/avi/.agents/skills/poteto-mode/SKILL.md`, and the Impeccable skill
(`/Users/avi/.agents/skills/impeccable/SKILL.md` then `reference/craft-floor.md`).

## Already built (do not change unless your lane brief says so)

- `apps/ui/components/workbench/`: `workbench-state.ts` (tab model, `update` action
  for patching a tab's target), `workbench-context.tsx` (`useWorkbench()` gives
  `{ state, dispatch }`), `workbench.tsx` (shell), `launcher.tsx`, `tools.tsx`,
  `workbench.css` (tokens and shared classes: `.wb-empty`, `.wb-note`, `.wb-icon`).
- `apps/ui/lib/pi/workbench.ts` (boundary parsers for every route; extend only the
  part for your tool) and `lib/pi/workbench-client.ts` (`useHostData`, `query`).
- `packages/pi-host/workbench/index.mjs` (dispatch, capabilities, suggestions),
  `paths.mjs` (`resolveInside(root, rel)`: use it for every path), `test-host.mjs`
  (`startHost()` boots a real host on a temp root; use it in your check),
  `check-workbench-core.mjs` (pattern for your check).

## Your slots (the only shared files you touch)

- `packages/pi-host/workbench/tools.mjs`: replace only your `undefined` with your
  module, e.g. `files: createFiles(options),` plus its import line.
- `apps/ui/components/workbench/panes.tsx`: replace only your commented case with the
  real case, plus its import line.
- `apps/ui/scripts/preview-pi-fixture.mjs`: add your fixture routes in one block
  marked `// workbench lane: <name>` placed directly above the line
  `if (url.pathname === "/api/plugins")`, and flip your tool to `{ available: true }`
  in the fixture's capabilities response. Label fixture data as fixture.
- `apps/ui/package.json`: add your unit test file(s) to `test` and your browser
  check to `test:ui` (append only).
- `apps/ui/lib/pi/workbench.ts`: extend only your tool's parser and types.
Everything else you create lives in new files named for your tool.

## Capability truth

A tool module the host registers makes `capabilities` report it available. If your
tool can be unavailable at runtime (no git, no python3), expose that through the
module (e.g. `available()` returning `{ ok, reason }`) and update `index.mjs`'s
`capabilities()` for your tool only, in a separate clearly marked line.

## Security (non-negotiable)

Routes are already behind owner auth and the origin check. Confine every path with
`resolveInside(work, rel)`. Never execute user-provided strings in a shell; use
`execFile` with argument arrays. Cap sizes and timeouts as the contract says. Your
real-host check must prove: 401 without auth, path escape rejected (403), the happy
path, and the size or rate limits that apply to your tool.

## Run and verify

The shared fixture runs on 127.0.0.1:3191 under a supervisor; restart it after your
fixture edit with `cp apps/ui/scripts/preview-pi-fixture.mjs /tmp/mars-fixture.mjs`
then `pkill -f "node /tmp/mars-fixture.mjs"` (the supervisor relaunches it; never
kill the supervisor). Your own lanes' fixture edits only show up after merge, so for
your browser check route the API with Playwright `page.route` like
`tests/workbench-ui-check.mjs` does, using fixture JSON in the test. Run your dev UI on
your lane port as in `.agents/lanes/COMMON.md`; use `http://localhost:<port>`.

Gate before reporting, from `apps/ui`: `mise exec -- npx tsc --noEmit`,
`mise exec -- npx eslint app components lib`, `mise exec -- npm test`, all browser
checks in `test:ui` against your port (`MARS_UI_PORT=<port>`), and from
`packages/pi-host`: `mise exec -- node check-workbench-<tool>.mjs` and
`mise exec -- node check-workbench-core.mjs`. Impeccable detector on your UI files.
Screenshots desktop 1440x900 and mobile 390x844, dark and light, to
`/tmp/mars-workbench-evidence/<tool>/`; look at them. Commit on your branch; do not
merge, push or deploy.

## Report

PASS, ISSUES or BLOCKED; files changed; what works; check results with numbers;
screenshot paths; anything left out and why; any change you needed outside your
slots, as an exact diff (do not make it).
