# Mars Claude-style redesign: shared lane brief

You are one lane of a parallel swarm rebuilding the Mars UI so it looks and
behaves very much like the Claude desktop app, built into the live Pi client.
The owner chose the direction, the Phase logo and the component list. Work
autonomously, then report.

## Read first (in your worktree)

1. `AGENTS.md`, `apps/ui/AGENTS.md`, `apps/ui/DESIGN.md` (the new design spec;
   it overrides any older Mars design notes), `apps/ui/PRODUCT.md`.
2. `apps/ui/components/workspace-context.tsx` (shared state and actions) and
   `apps/ui/components/live-workspace.tsx` (the controller; do not restructure it).
3. `apps/ui/lib/pi/live-state.ts` (the only data the UI has; `LiveSnapshot`).
4. `apps/ui/app/design-system/component-gallery.tsx` for working usage of every
   vendored component with realistic props.
5. The Impeccable skill: `/Users/avi/.agents/skills/impeccable/SKILL.md`, then
   `reference/craft-floor.md` before editing UI. Skip its init/interview steps:
   PRODUCT.md and DESIGN.md already exist and the direction is approved.

## Hard rules

- Edit only the files your lane owns (listed in your lane brief). If you need a
  change elsewhere, do not make it; describe it in your report under
  "Cross-lane requests" with the exact diff you want.
- Real Pi data only. Never render a vendored component with its demo defaults
  (several Kokonut components animate fake data when a prop is omitted). If Pi
  does not supply what a component needs, leave it out and say so.
- Keep every accessible name the tests use: "Message Mars", "Send message",
  "Stop response", "Choose model", "Open settings", "Open navigation",
  "New chat", "Attach images", "Copy response", "Back to parent",
  "Close navigation", plus anything a test in `apps/ui/tests/*.mjs` selects
  (grep the tests for your surface before renaming anything). Keep class names
  the tests select (`.live-sidebar`, `.live-subthread`, `.live-mobile-nav`,
  `.live-workers > summary`, `.live-workflow > summary`, `.live-image-draft img`,
  `.live-message-images img`, `.live-plugin-card`, `.live-activity`) or update
  the test in the same lane only if your lane owns that test's surface and the
  behaviour is preserved.
- Semantic tokens only (`var(--clay)`, `var(--text-muted)` ...). No raw hex in
  component CSS. Australian English, no em dashes in UI copy.
- Motion 120 to 200ms, `var(--ease-out)`, respect reduced motion.
- Do not commit credentials, do not touch `packages/pi-host` unless your brief
  says so, do not push.

## Run and verify

- Node is pinned: prefix commands with `mise exec --`.
- A fake Pi host (fixture) is already running on `http://127.0.0.1:3191`. Start
  your own UI dev server on your lane port, in the same shell command as your
  checks (background processes die between commands in this sandbox):
  `cd apps/ui && MARS_PI_ORIGIN=http://127.0.0.1:3191 MARS_PI_TOKEN=preview-fixture MARS_UI_PORT=<port> node scripts/next.mjs dev &`
  then wait for `curl -fs http://127.0.0.1:<port>/`.
  Fixture conversations: `?conversation=1` (tools, edit patch, failed bash,
  workers, workflow, subthread "4", context), `?conversation=2` (empty),
  `?conversation=4` (child thread with Back to parent).
- Screenshot your surface with Playwright (`@playwright/test` chromium, use
  `tests/browser-options.mjs` `browserLaunchOptions()`) at 1440x900 and 390x844,
  in dark and light (`localStorage.setItem("mars-live-theme","light")` then
  reload). Save PNGs to `/tmp/mars-lanes-evidence/<lane>/`. Look at them and fix
  what is wrong. At most two inspection rounds.
- Before reporting, all must pass from `apps/ui`:
  `mise exec -- npx tsc --noEmit`, `mise exec -- npx eslint app components lib`,
  `mise exec -- npm test`, and the browser fixtures for your surface run against
  your lane port: `MARS_UI_PORT=<port> mise exec -- node tests/<check>.mjs`
  (all six: live-client-check, connections-ui-check, claude-ui-check,
  conversations-ui-check, images-subthreads-ui-check, plugins-activity-ui-check).
  Run the Impeccable detector once on your changed files:
  `/Users/avi/.agents/skills/impeccable/scripts/impeccable detect --json <files>`.
- Commit on your lane branch with a clear message. Do not merge or push.

## Report (final message)

`PASS`, `ISSUES` or `BLOCKED`, then: files changed; what now matches the Claude
app; screenshot paths; check results with numbers; anything left out because Pi
lacks the data; cross-lane requests with exact diffs.
