# Goal: Mars workbench split pane (overnight)

Work in `/Users/avi/Documents/ChatGPT/mars 3` on branch `codex/claude-redesign`
(continue it; create `codex/workbench` from it if you prefer a fresh branch). Mars is
a Pi Durable host (`packages/pi-host`) plus a Next.js UI (`apps/ui`) redesigned to
look like the Claude desktop app. Use Australian English and no em dashes anywhere.

## Read first, in order

1. `AGENTS.md`, `apps/ui/AGENTS.md`, `apps/ui/DESIGN.md`, `apps/ui/PRODUCT.md`,
   `docs/MONOREPO.md`, `packages/pi-host/HOST-GUIDE.md`, `.agents/CHANGELOG.md`.
2. `.agents/lanes/COMMON.md` for how to run the fixture-backed preview and checks.
3. `apps/ui/components/live-workspace.tsx`, `workspace-context.tsx`,
   `components/shell/*`, `components/settings/extensions-page.tsx` (how installed
   extension UIs mount today), `lib/pi/live-state.ts`, `packages/pi-host/server.mjs`.
4. Skills: pstack `figure-it-out`, `swarm`, `show-me-your-work`, `principle-prove-it-works`;
   Impeccable (`/Users/avi/.agents/skills/impeccable/SKILL.md`, then
   `reference/craft-floor.md` before UI edits). Skip Impeccable init: direction is approved.

## Objective

Add a Claude/ChatGPT-desktop-style workbench to the live Mars app.

1. A `+` icon button at the top right of the conversation header (accessible name
   "Open workbench"). It splits the main area into the chat on the left and a
   workbench pane on the right, with a draggable, keyboard-resizable divider,
   persisted width, a close button and an expand/restore toggle. Opening it never
   loses the draft, scroll position or the selected conversation. On screens 768px
   and narrower the workbench opens as a full-screen sheet with a clear back action.
2. The workbench supports tabs. A new tab shows a launcher like the ChatGPT desktop
   "New tab" page (see the owner's reference): a **Tools** grid of tiles with icons
   and keyboard shortcuts, and a **Suggested** row below it.
3. Tools tiles, each a real, working pane backed by the Pi host:
   - **Changes:** git status and diffs for the Pi workspace repo(s), rendered with the
     vendored 21st/Pierre diff and the Kokonut Diff Review shell. Read-only unless a
     guarded action is genuinely implemented and tested.
   - **Files:** a scoped file tree and viewer of the Pi workspace (`WORK`), with
     quick open, Markdown/code/image preview and read-only by default.
   - **Terminal:** an interactive shell in the Pi workspace via xterm.js over an
     authenticated WebSocket PTY on the host. Closing the pane detaches; killing the
     process is a separate explicit action.
   - **Side chat:** a second Pi conversation in the pane (create or pick one), using
     the same composer and thread components, without disturbing the main chat.
   - **New page:** a simple Markdown note saved in the Pi workspace (e.g.
     `workspace/pages/`), editable with preview, listed for reopening.
   - **Browser:** a sub-browser pane with an address bar, back/forward/reload, for
     local services the host can reach, proxied through the authenticated host.
     External sites that refuse framing open in a new browser tab with a clear note.
   - **More tools…:** expands to every installed extension that has a UI; each opens
     in its own pane using the existing extension mount (`/extensions/<hash>/client.js`).
4. **Suggested:** live things running now, discovered by the host: listening local
   HTTP services on the VM (name, port, page title where fetchable), installed
   extension UIs, recent workspace pages. Selecting one opens it in a pane.
   Never show a service that is not actually listening.

## Hard rules

- Real data only. Every tile is either working end to end or shown disabled with an
  honest reason ("Needs the host's terminal service"). No demo panes in the live app.
- Security: every new host route requires owner auth and the existing exact-origin
  checks; WebSocket upgrades use the same policy as the current HMR upgrade. File and
  git access are confined to the Pi workspace roots (reject `..`, symlink escapes and
  absolute paths outside). The browser proxy only reaches loopback/private targets the
  owner configured or that the host discovered listening, never arbitrary internet
  hosts, and strips cookies/authorization in both directions. The PTY is bounded
  (one per pane, idle timeout, size limits) and never logs input.
- Never commit credentials, `.env` files, native data or personal screenshots.
  New dependencies are pinned exact versions with permissive licences recorded in
  `apps/ui/licenses/` or the package docs (xterm.js MIT; node-pty MIT if used; check
  it builds on macOS and Linux).
- Preserve every existing behaviour and every accessible name the tests use. Keep
  `/design-system` current: add the workbench, launcher tiles and each pane.
- Do not push, open PRs, deploy (`host_deploy`) or touch the live Bot Box services,
  accounts or paid model calls. All verification uses the preview fixture and the
  real-host check harness (`packages/pi-host/check-*.mjs`) with temp data roots.

## How to work

- Use pstack `figure-it-out` to plan and `show-me-your-work` to keep a decision trail
  in `.agents/goals/workbench-log.tsv` (commit it).
- Phase 0: data shapes and host contracts first (`architect`): pane/tab model and
  persistence, host routes for files, git, pages, services, PTY, browser proxy. Write
  them into `docs/WORKBENCH.md` before code.
- Phase 1: split pane, tabs, launcher (with disabled tiles until backed). Verify.
- Phase 2 onwards: one tool per phase (host route + check, fixture support, UI pane,
  tests, screenshots). Use pstack `swarm` with git worktrees under
  `/Users/avi/Documents/ChatGPT/mars-lanes/` and disjoint file ownership when tools
  are independent; merge and re-verify after each wave.
- Extend `apps/ui/scripts/preview-pi-fixture.mjs` so every pane is demonstrable in the
  preview (fixture file tree, fake git diff, fake service list, scripted PTY echo),
  clearly labelled as fixture data.
- Also fix: the effort slider clips "Extra high" in the model menu (use a shorter
  label such as "XHigh" or adapt the stops), with a screenshot proving it.

## Verification gate for every phase

From `apps/ui`: `mise exec -- npx tsc --noEmit`, `mise exec -- npx eslint app components lib`,
`mise exec -- npm test`; all six browser fixtures plus new ones you add for the
workbench (open/close/resize, each pane, keyboard, mobile 390px with no horizontal
overflow); `MARS_BUILD_CHECK=1 mise exec -- npx next build --webpack` (then restore
`next-env.d.ts`). From `packages/pi-host`: `mise exec -- node run-checks.mjs --json`
with new checks for every new route (auth required, path escape rejected, proxy target
rejected, PTY lifecycle). Known Mac-only failures that predate this work:
check-dev-tools, check-ui-patches, check-vm-control and the flock installer tests;
report them, do not "fix" them by weakening checks. Run the Impeccable detector on
changed UI files. Take desktop 1440x900 and mobile 390x844 screenshots, dark and light,
into `/tmp/mars-workbench-evidence/` and look at them.

## Done when

The `+` button opens a resizable split workbench; the launcher shows Tools and
Suggested; Changes, Files, Terminal, Side chat, New page, Browser and extension panes
all work against the fixture and pass real-host checks; all gates above pass; DESIGN.md,
`docs/WORKBENCH.md`, `/design-system` and `.agents/CHANGELOG.md` are updated; work is
committed locally in small verified commits. Finish with a plain-English report:
what works, screenshots, exact check counts, anything left disabled and why.
