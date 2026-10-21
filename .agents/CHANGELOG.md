# Change log

20 October 2026: scaffolded the owner-authorised replacement of ZCode with the
Pi Durable and Mars UI monorepo. Imported the complete UI ancestry through
db85735, including the agent's latest configuration/search/deploy changes.
Preserved former Mars source in Git and private backup. Migration contract is
in docs/MONOREPO.md. Installation and portability checks remain in progress.
## 2026-10-20 UI monorepo integration

- Preserved Pi live UI, local fonts, assistant-ui binding, image input, subthreads, ordered workflows, activity and plugin cards.
- Configured explicit workspace tracing/Turbopack roots and exact MARS_PUBLIC_ORIGIN development hostnames. Added portable loopback Next launcher with MARS_UI_PORT.
- Consolidated browser discovery through pinned Playwright, removed checkout-specific browser paths and made the opt-in existing-host check configurable.
- Removed duplicate UI handoff scaffolding and obsolete runtime-retention/demo model instructions. Kept component notices and native fixture proof markers.
- Verified UI typecheck, lint, 23 unit tests and actual Next configuration loading. Browser fixtures and production build are integration checks for the parent lane.

## 2026-10-20: portable Pi host for the Mars monorepo

Derived data, repository, UI, Node and hoisted SDK paths; retained explicit old data
roots, added configurable ports and exact HTTP/WebSocket proxy origins and aliases.
Self-deployment now stages the root workspace lock, installs host dependencies only,
keeps active dependency snapshots and restores dependencies on watchdog rollback.
Frontend patch validation finds workspace dependencies. Runtime guides reflect the
Pi and UI layout. All 20 native checks passed, including a real temporary-root
host restart/auth/proxy test and monorepo staging/dependency rollback fixtures.
No live service or account was changed by this lane.
## 2026-10-20 Pi monorepo installer

Added exact Node24.14.0/npm11.9.0 workspace manifests and one root npm lock,
private idempotent bootstrap, local authenticated sign-in URL, development and
production process launchers, isolated production smoke verification and portable
Linux user-service generation. Production uses .next-build and development uses
.next. The installer preserves existing native data, credentials, owner guides
and extra private service configuration. Root dependency installation, typecheck,
lint, seven installer/process/systemd-parser tests and JavaScript syntax passed.
Production smoke and full integrated native/browser verification remain for the
integration checkout after the portability and UI lanes are combined.

## 2026-10-20: verify the first workspace dependency installation

An existing standalone host without an installed workspace lock marker now always
performs the filtered native workspace install. The checkout lock no longer counts
as proof of installed dependencies. Regression fixture uses matching declarations
and a missing marker, then verifies the deployed marker and dependency rollback.
## 2026-10-20 Host ownership and runtime separation

The documented host launcher now requires resolved flock and acquires the shared
private data/host.lock before native code or SQLite starts. Services record the
resolved executable. A second host using the same root is rejected across ports,
and SIGKILL releases ownership for restart. Bootstrap atomically initialises a
separate private app runtime only when absent, including its workspace lock and
dependency link. Subsequent setup preserves runtime changes and never replaces
existing app files. Concurrent first setup publishes one complete persistent
owner token. Installer tests cover real SQLite ownership, crash release, runtime
preservation, concurrent setup and missing-flock failure without fallback.


## 2026-10-20 assembled migration verification

Combined the three lanes and retained the latest agent changes. Added root boundary
policy and negative import test, fixed native check execution from paths with spaces,
and added an operator host:deploy command using the same staged native workflow.
Removed the personal screenshot archive from the public tree. Full UI/private
history stays in private backup; publication uses a reviewed source snapshot with
public Mars ancestry only. Generic UI wording now refers to Pi/workspace.

Clean npmci476, typecheck, lint,13 script tests,23 UI units,20 native checks,
production build,6 browser fixtures and fresh isolated production restart pass.
Actual live cutover and final public publication remain the next phase.

## 2026-10-20: isolate UI validation dependencies from the native host

Frontend patch validation now resolves Next from the UI source package and mounts
that hoisted dependency tree. It never substitutes a filtered host SDK tree. Local
standalone and toy fixture dependency directories still work. All 10 UI patch
fixture scenarios pass, including real Bubblewrap/npm validation with separate
hoisted Next/TypeScript packages and a native-only deployment dependency tree.


## 2026-10-20 managed dependency validation

The real assembled host stage passed20checks, locked host-only installation and
isolatedboot. Actual UIpatch validation with native-only host dependencies passed
real typecheck, lint and webpack build inside Bubblewrap, with no promotion.
Resolved UIdependencies from the UIworkspace independently of runtime dependencies.
Bumped hostVersion to mars-monorepo-1 for an observable cutover check.

## 2026-10-20 public monorepo and live cutover

Published the reviewed Pi Durable plus Mars UI tree on public Mars ancestry,
excluding private UI history and personal screenshots. Switched the canonical
checkout and both user services to the monorepo. The native staged deployment
passed20 checks, locked installation, isolated boot and watchdog health. Compared
131 root entries, saved model, both OAuth connections, credential/token hashes and
all plugin hashes/settings against the private baseline. Four image-demo children
and the completed three-step workflow survive. Routed tailnet443 and9443 to Pi;
removed retired8443/8787 routes. TLS owner API probes pass on both active ports.
Legacy code/data and full Git histories remain backed up privately. No live model
calls or external messages were made. Full automated results and limitations are
in docs/MIGRATION-RESULTS.md.

## 2026-10-20 activity lane: Claude-style tool activity and task cards

Tool calls now render as a Claude-style group line ("Ran 1 command, read 1 file,
searched the web") with the "N actions" count kept beside it. Each call is one
quiet row with a chevron; expanding it mounts the 21st Bash terminal card, the
21st Edit diff card (from Pi's details.patch, else edits or write content, inside
DiffHighlighterReady), or a plain output for read, search, fetch and unknown
tools. components/ai/tool-adapter.ts maps ToolActivity to those props and is
covered by tests/tool-adapter.test.mjs (in npm test). Status, durations and exit
codes come only from Pi data. Workers and workflows are compact task cards with
StatusMark, model, elapsed time, open-thread links and the existing stop
controls. Usage with no workers or workflows is a quiet line, hidden in an empty
chat. The vendored bash card scrolls long output instead of clipping it.

## 2026-10-20 Claude-style redesign of the live Pi client

Replaced the screenshot-ledger DESIGN.md with a Claude desktop direction:
warm charcoal and ivory tokens, one clay accent, the Phase Mars mark (sidebar,
greeting, favicon). Added /design-system as the live token, mark and component
preview. Vendored the selected Kokonut UI, 21st Agent Elements, assistant-ui
Elements and AI Elements source with a hashed register and licences, themed to
Mars tokens by script. The Pi host now reports the current context window the
way Pi Durable measures it for compaction, and accepts /api/compact.

Five parallel lanes rebuilt the live UI on that base:
- Shell: 288px sidebar collapsing to a 56px rail (mars-sidebar-collapsed),
  shared sidebar and drawer tree, Recents with a running dot, quiet subthread
  status, 48px borderless header, inline error banner.
- Composer: one 20px surface on the assistant-ui composer runtime, Radix model
  menu from Pi's model list (no effort levels: Pi exposes none), clay send and
  stop, 56px image drafts, Kokonut-style context meter fed only by
  snapshot.context with estimates labelled and Compact now.
- Thread: 768px column, serif greeting beside the mark, user bubbles, unboxed
  Markdown with code headers and copy, quiet outcome notes, pulsing mark while
  running. chat-thread.css removed.
- Settings: 760x560 dialog with a left tab rail, full-screen sheet on phones,
  theme cards painted by their own data-theme, true-black OLED, restyled
  buttons, inputs, switches and tabs, a calm Extensions page.
- Activity: see the entry above.
Verification is against the preview fixture only; see the integration entry.

## 2026-10-20 redesign integration check

After merging all five lanes: typecheck and lint clean, 33 UI unit tests pass,
workspace boundaries pass, production build passes, and all six browser
fixtures pass against the merged UI on the preview fixture. Native host checks:
18 of 21 pass, including the new context meter check and a real fresh-host
boot reporting partitioned context. check-dev-tools, check-ui-patches and
check-vm-control fail identically on the untouched pre-redesign commit on this
Mac (Bubblewrap and /var path assumptions); the installer script tests need
util-linux flock. Both need the Linux Bot Box. No live Pi host, account or
model call was used; nothing was pushed or deployed.

## 2026-10-21 workbench Files pane

The Files tool now opens a read-only view of the Pi workspace beside the chat: a
keyboard tree (one tab stop, arrows, Home and End) beside a viewer, stacked on
narrow panes and phones. Breadcrumbs, Cmd/Ctrl+P quick open by name, rendered
Markdown with workspace links and images (remote images are never fetched),
numbered source, sniffed images and "Binary file, N KB". The tab keeps its path so
a reload reopens the file. Host routes confine every path, mark links that leave
the workspace instead of following them, sniff images from bytes (SVG stays text),
cap listings at 2,000 entries, text at 2 MiB, raw images at 20 MiB, and search at
200 results and 3 s while skipping node_modules and .git. Verified by
check-workbench-files.mjs on a real temporary host and a fixture browser check;
no live Pi host was used.

## 2026-10-21 workbench lane: Changes

Added the read-only Changes tool. Host: `workbench/changes.mjs` serves
`/api/workbench/repos` (git repos up to depth 3 under the workspace, branch,
ahead/behind, dirty) and `/api/workbench/changes` (file list with status, exact
+/- counts and binary flag, patch capped at 1 MiB, untracked text files as
additions, at most 50). Git runs through `execFile` with no pager, external diff,
textconv, hooks, fsmonitor or repo-configured filters, `GIT_OPTIONAL_LOCKS=0` and
a 10 s timeout. Capabilities report "git was not found on the host." when git is
missing. UI: `changes-pane.tsx` with a repo picker, branch and ahead/behind,
refresh, the Kokonut Diff Review file list and the 21st EditTool diff card per
file; no accept or reject. Verified with `check-workbench-changes.mjs` against a
real host on a temporary root, 5 new unit tests and a fixture browser check at
1440 and 390px in dark and light. No live Pi host, account or model call was used.
## 2026-10-21 workbench lane: pages and side chat

Pages host module (`packages/pi-host/workbench/pages.mjs`): Markdown pages in
`WORK/pages`, names `[a-z0-9-]{1,64}`, generated `untitled[-n]` names, title from
the first `# heading`, 1 MiB cap, atomic temp-file-and-rename writes, exclusive
creates, a serialised `baseModified` conflict check (409 with the newer time),
every path through `resolveInside`, and `list()` feeding Suggested. Page pane:
list, New page, a sans Markdown editor with a live preview toggle, 800 ms
debounced autosave with a Saved state, and "Changed elsewhere: reload or
overwrite" that never overwrites without an explicit click. Side chat pane: pick
or create a second Pi conversation, its own assistant-ui external store runtime
with the shared message renderers, 1.5 s polling only while visible, a compact
composer sending with `conversationId` and a `requestId`, and Stop scoped to that
conversation; the main chat's selection, draft and scroll are untouched.
Verified with `check-workbench-pages.mjs` on a real temporary host, unit tests and
`workbench-pages-check.mjs` on fixture routes only. No live Pi host, account or
model call was used.
## 2026-10-21 workbench lane: terminal

Host: `workbench/terminal.mjs` runs `python3 pty-bridge.py <shell> -l` in the
workspace with PATH, HOME, LANG, TERM, SHELL and USER only. It keeps at most 4 live
sessions, a 256 KiB output ring with absolute byte offsets and `dropped`, 20 s long
polls, 64 KiB input requests and resizes clamped to 20..400 by 5..200. The idle
timeout is 30 minutes (`MARS_TERMINAL_IDLE_MS` overrides it for tests). Kill hangs
up every process group on the session's tty, then forces any left after 1 s.
Input is never logged. UI: a lazy-loaded xterm 6.0.0 pane, themed from Mars tokens,
that follows theme changes. It refits on resize, reattaches after a reload,
shows "Reconnecting…" with backoff, and offers New session and End session.
Verified by check-workbench-terminal (real host, real shell), 7 unit tests, a
fixture browser check, and an ad hoc run through the Next dev proxy to a real host
with zsh. Nothing was pushed, deployed or run against a live service.

## 2026-10-21 Workbench shell hardening

- Only the main chat is keyed by the selected conversation, so switching chats no longer remounts the workbench or side chat.
- Tool shortcuts respect host capabilities: a tool the host cannot run opens the New tab with its reason instead of a broken pane.
- Phone sheet: focus moves into the sheet, the chat behind it is inert, Escape closes it and focus returns to the toggle.
- Narrow desktop: the pane keeps its 360px minimum (`max(360px, 100% - 420px)`); the separator reports the rendered width and its maximum.
- `workbench-ui-check` covers each of these, with two mutation runs (shortcut gate, inert) shown to fail.

## 2026-10-21 Workbench panes in /design-system

- `/design-system` now renders every real workbench pane (New tab, Files, Changes, Terminal, Side chat, Page) inside an embedded workbench, switched by a pane picker.
- `app/design-system/sample-host.ts` answers the workbench routes in-page while the specimens are mounted, so nothing reaches Pi. All data is illustrative.
- `WorkbenchProvider` takes `initial` and `persist={false}` for embedded specimens: no stored layout, no global shortcuts, no phone sheet.
- Evidence: `/tmp/mars-workbench-evidence/design-system/` desktop and 390px screenshots for each pane, no page errors, no horizontal overflow.

## 2026-10-21 Workbench docs

- docs/WORKBENCH.md records the terminal transport decision (Python PTY bridge and long polling, not node-pty and WebSocket), shell hardening, embedded provider mode and design-system specimens. DECISIONS.md gains the terminal ADR; DESIGN.md describes the panes.

## 2026-10-21 Changes pane security fixes (independent review)

- Filter, pager, hook and fsmonitor overrides now go through GIT_CONFIG_KEY_n/VALUE_n. A driver named `a=b` had dodged the `-c` override and ran a repository's clean filter (reproduced, now a regression in check-workbench-changes with a mutation run).
- git runs with a minimal environment (PATH, HOME, LANG) and GIT_CONFIG_NOSYSTEM, never the owner token or provider keys.
- Repositories whose .git borrows data (commondir, gitdir, alternates, grafts) or links its parts elsewhere are refused with 403, closing reads outside WORK.
- git failures return a generic message instead of stderr, which could quote host paths or config lines.

## 2026-10-21 UI proxy closed in production (independent review, critical)

- `apps/ui/lib/server/pi-proxy.ts` added the owner token for any caller, and its "local only" check read `request.url`, which is always 127.0.0.1 because Next binds there. A DNS-rebinding page could read files and terminal output, and any local process could open a shell (reproduced on `next start`; predates the workbench, which made it reach a shell).
- The proxy is now off in production builds (404): production browsers reach `/api` on the Pi host, which authenticates the owner itself. In development it also checks the Host header the browser actually sent. New unit test; the reviewer's probe now gets 404 for every request, and the owner path through the host still serves pages, state and workbench capabilities.
