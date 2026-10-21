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

## 2026-10-21 Swap-race fixes for Files and Pages (independent review)

- `paths.mjs` gains `openInside` and `writeNewInside`. After opening, `handleInside` proves the open handle is the file inside WORK: through /proc/self/fd on Linux, and elsewhere with two component-by-component lstat walks that must agree and end on the open inode.
- Files reads use `openInside`. Page reads use it too (non-blocking, no symlinks), and page titles in listings open non-blocking, so a FIFO swapped into pages/ cannot hang a worker thread.
- Page saves write their temp file with `writeNewInside`. If the folder was swapped mid-write, the bytes are wiped through the handle and the save is refused.
- New `check-workbench-races.mjs` flips a folder to a symlink outside WORK, and a page to a FIFO, during reads and saves. Mutation runs: without the recheck, 360 of 10,684 racing reads leaked; with blocking page reads, 1 of 248 hung.

## 2026-10-21 Workbench Browser and extension panes

- Host `workbench/browser.mjs`: lsof or ss discovery of loopback HTTP services with titles, owner-minted per-port browse keys (in memory, 30 min idle, 8 h max, revocable), keyed proxy checked before owner auth and granting only its own port, header stripping both ways, sandbox CSP, no-referrer, same-service redirect rewriting, 20 MiB caps, and root-relative rewriting of HTML, CSS and JS plus an in-page shim for fetch, XHR, EventSource and history. `server.mjs` calls `workbench.handleKeyed` before the owner check.
- UI `browser-pane.tsx`: address bar, Back, Forward and Reload from its own history, sandboxed iframe without allow-same-origin, postMessage navigation accepted only from its frame and port, external URLs open outside. `extension-pane.tsx` reuses the exported `ExtensionPanel`.
- Next dev proxy: the keyed path is forwarded without the owner token, exempt only from same-site and JSON checks; `skipTrailingSlashRedirect` keeps the `<base>` slash.
- Checks: `check-workbench-browser.mjs` on a real temporary host (mint auth and origin, port binding with a mutation run, unknown, revoked and expired keys, key never logged or usable as an owner credential, dot segments, header stripping, caps, discovery ignoring non-HTTP and excluded ports). `workbench-browser-check.mjs` drives a multi-asset fixture app through the real dev proxy: root-relative CSS, module JS and fetch, opaque origin that cannot read Mars or its API, link navigation, Back, Forward, Reload, persistence, external URL, refused port, four screenshots. The shell check now mounts an extension in its own tab.
- `tests/browser-options.mjs` gains `waitForHydration`, used by every workbench check, after clicks before hydration were silently lost.
- The browser lane worker stalled twice with no file changes, so the parent finished the lane directly from its inherited host draft.

## 2026-10-21 Browser in /design-system

- The `/design-system` pane picker gains Browser (address bar and empty state; the loaded page is shown by `workbench-browser-check` screenshots, because frame navigation cannot be answered in-page). The empty state is centred at 360px with a styled `kbd`. Impeccable detector on changed workbench files: no findings.

## 2026-10-21 Workbench verification notes

- `.agents/verification.md` lists the workbench gate, the host checks and what they do not prove.

## 2026-10-21 Workbench UX fixes (independent visual and keyboard review)

- Focus follows the user: a tool opened from the launcher (mouse or keyboard) focuses its main control (the file tree, a text field, then any control). It stops as soon as the user moves focus, and a pane updating its own target never moves focus.
- Tabs shrink to a 72 to 180px range before they scroll. The selected tab is scrolled into view, and an overflowing strip fades at its right edge.
- The launcher switches to one column in a pane narrower than 520px (container query), so tool names stay readable at the 360px minimum.
- Pane toolbars for Files, Changes, Browser and Terminal share one 44px bar.
- Light mode contrast: the semantic colours are darker (`--green #2f6f3a`, `--red #a2402a`, `--amber #8a5a00`, `--blue #36628c`), shortcut hints use a stronger text mix on a lighter tint, dotfile and folder notes use `--text-muted`, and xterm has `minimumContrastRatio: 4.5`.
- The "New page" tool is now "Pages", which matches what it opens (the page list with its own New page button).
- The chat keeps 480px beside the pane (was 420px), so the composer's model picker is not squeezed at 1024px.
- `workbench-ui-check` asserts launcher focus and the selected tab in view. Mutation runs: without the focus effect the check times out; without scroll-into-view it fails.
- Not changed, noted for later: side chats are listed in Recents like other conversations, binary files have no download action, and the header toggle keeps the name "Open workbench" with `aria-pressed` (the toggle pattern the tests rely on).

## 2026-10-21 Browser proxy hardening (second independent security review)

- Fixed two host crashes a hostile service or key holder could trigger: an unparsable keyed path (`//[`) threw in a response callback, and an upstream status such as 099 threw in `writeHead`. Upstream callbacks are now guarded, statuses outside 200 to 599 (and 304) become 502, and the document URL is built without `new URL` on attacker input.
- Fixed a ReDoS that blocked the host for 13 to 48 s per page: `<script`, `<base`, `<head` and `<title` handling is now linear (`tagAt`, `tagEnd`, `attribute`). One megabyte of hostile tags rewrites in milliseconds.
- Memory and slowloris: only text up to 2 MiB is buffered for rewriting, a quiet body is cut off after 30 s, discovery probes have a hard deadline, and in-flight proxied requests are capped (24 total, 12 per port, else 503).
- Response headers are forwarded from an allow list, with nosniff always set. Keys idle out after 15 minutes and are bound to the listening process, so a port takeover does not inherit an old key. The dev proxy reads keyed bodies through a 20 MiB bounded reader.
- New `check-workbench-browser-hostile.mjs` (bad path, bad status, hostile HTML, trickle, flood) and a port-takeover case in `check-workbench-browser.mjs`. Mutation runs: without the status and callback guards the check fails; without process binding the takeover case fails.
- Accepted risk, documented: a key read by third-party script inside a proxied page can drive that one service until it idles out. The proxy sets `Host` to the loopback address, as any reverse proxy does.

## 2026-10-21 Final workbench gate

- The browser check's takeover child no longer inherits stderr (it held the check runner's pipe open) and is awaited on exit.
- Gate on this commit: tsc and eslint clean; 76 of 76 unit tests; 12 of 12 browser checks (six original fixtures plus six workbench); native 26 of 29, with all 8 workbench host checks passing and the same three Mac-only failures as original f82d5d0 (check-dev-tools, check-ui-patches, check-vm-control); syntax and boundary checks pass; production build passes.

## 2026-10-21 Workbench decision log

- Decision trail updated in `.agents/goals/workbench-log.tsv`. Lane worktrees removed; their branches are kept (codex/wb-*).

## 2026-10-21 Side chats nested under their parent, file downloads, agent tools

- Side chats are ordinary ownerless Pi conversations plus a native `mars.side-chat` document naming their parent (`packages/pi-host/side-chats.mjs`). Pi stays the only store. `POST /api/conversations` takes `parentId`; parents are checked before anything is created, so a refused side chat leaves no orphan, and nesting is one level only.
- Recents lists top-level conversations only; each row carries `sideChats`. `/api/state` gives a side chat `parentConversationId` and `sideChatOf`. The sidebar nests side chats under their parent with a side-chat glyph and keeps the open one listed. The workbench side chat is created under the chat in the main view, and its picker shows side chats nested.
- Agent control: deferred tools `side_chat_open` (optional first task, replay-safe through `memo`), `side_chat_list` and `side_chat_send` (only the caller's own side chats), and `workspace_file_link` (a checked download URL, never contents). Codemode namespaces `sideChats` and `workspaceFiles`. All are listed and switchable in Extensions like other host tools.
- `GET /api/workbench/download?path=`: any regular file in WORK up to 20 MiB through `openInside`, as an octet-stream attachment with nosniff and a sandbox CSP. The Files viewer has a Download button, and binary files get a labelled one. The dev proxy keeps `content-disposition` for this route.
- Checks: new `check-side-chats.mjs` on a real harness, where a scripted model drives the agent tools (with a mutation run proving the ownership check); download and `link()` cases in `check-workbench-files.mjs`; new `side-chats-download-check.mjs` in the browser (nesting, parentId on create, real downloads with exact bytes, phone and light); two parser unit tests.

## 2026-10-21 Side chat and download hardening (third independent security review)

- Side chats are now created in one commit: the conversation, its agent settings, title, `mars.side-chat` link and the parent's new `mars.side-chat-index` entry, with the parent re-checked inside that commit. This closes the crash-orphan and replay-duplicate gap (M3) and the nest-under-a-side-chat race (L1).
- Recents reads each parent's index instead of scanning every newer conversation (M1). It shows the newest 20 plus `sideChatTotal`, with an "older side chats" line, and `side_chat_list` pages by offset, so a flood cannot hide the owner's side chats (M2). Parents are capped at 200 side chats. Listing is read-only (L2). Forks start with neither document.
- Downloads refuse hard-linked files (L4). `filename*` percent-encodes `'()*` (RFC 5987). `workspace_file_link` errors are plain reasons with no host path (L3).
- Checks: `check-side-chats.mjs` adds read-only listing, paging, the exact index, forks, the cap and a timing bound, with mutation runs for the cap and read-only listing. `check-workbench-files.mjs` adds hard links, plain link errors and RFC 5987.
- Gate: 78 of 78 unit tests, 13 of 13 browser checks, native 27 of 30 (the same three Mac-only failures), syntax, boundaries and production build all pass.

## 2026-10-21 Tool definitions written for small models

- `docs/TOOLS.md` sets the standard: first line a verb and outcome, when to use it versus its neighbours, what it returns, every field described with units and defaults, a typed result, and a copyable `Example:` call.
- `tool-quality.mjs` encodes it and `check-tool-quality.mjs` runs it on every installed tool, dumped from the real host (`MARS_DUMP_TOOLS`, never reachable over HTTP). Examples are evaluated as literals and validated against the input schema. `check-tool-quality-rules.mjs` proves each rule catches its defect.
- Rewrote all 36 Mars tools (vm-control, workers, workflows, web, side chats, file links, plugins, Discord, UI patches, extensions, self-deploy, discovery reset). 82 of 99 fields had no description before; all do now. Every tool has a typed result, so codemode scripts get objects, not JSON strings. Plugin and file-link tools moved to `host-tools.mjs`. Codemode namespaces now cover every tool group, and HOST-GUIDE.md has a which-tool-for-which-job table.
- Forgiving arguments (`prepareArguments`): JSON-string and plain-string lists for `worker_fanout` and `workflow_start`, and a saved-output id passed to `host_read`. `check-tool-arguments.mjs` proves the repairs and that unrepairable values still fail. `check-web-search.mjs` now validates results against the declared schemas.
- Measured with a local 1.5B model (qwen2.5:1.5b through Ollama, free), 14 requests x 5 runs, all Mars tools offered: fully correct calls went from 29/70 to 54/70 (two further runs: 33 to 51, 31 to 54). Rerun with `packages/pi-host/scripts/eval-tools-small-model.mjs`.

## 2026-10-21 plan_update: the agent's own checklist, and choosing how to run multi-step work

- New tool `plan_update` (`packages/pi-host/plans.mjs`): the agent sends its whole checklist, `[{ step, status }]` with pending, in_progress or completed, and calls again as it works. It is stored in a native per-conversation `mars.plan` document, so it survives a restart, and `/api/state` returns it as `plan`. At most one step can be in progress (enforced). Forgiving input covers plain strings, a JSON string, "done" and "doing", and `text` or `title` for the step.
- The agent now chooses by who does the steps: `plan_update` (itself, in this chat), `workflow_start` (helper models in order, in the background) or `worker_fanout` (helpers at once). The choice is in docs/TOOLS.md, HOST-GUIDE.md and each tool's description. A checklist sent to `workflow_start` by mistake is refused with an error naming plan_update. In a focused 10-run probe a 1.5B model picked plan_update first every time; recovery after that error was not tested (corrected 2026-10-21, see below).
- Thread UI: `PlanCard` above the run status, with an empty dashed circle for pending, a spinner for in progress (still under reduced motion) and a tick for done. Each status is spoken for screen readers. A finished plan collapses to "Plan: 2 of 2 done" and opens on click.
- Checks: `check-plans.mjs` drives the tool through a real harness with a scripted model (mutation run on the one-in-progress rule); `tests/plan-check.mjs` in the browser (states, spoken status, reduced motion, collapse, no plan means no card, 390px); a parsePlan unit test; mode-choice requests added to the small-model evaluation.
- Gate: 79/79 unit, 14/14 browser checks, native 31/34 (the same three Mac-only failures), syntax, boundaries and build pass.

## 2026-10-21 Pre-merge fixes: side-chat replay, blank plan steps, plan specimen

- `side_chat_open` replay: the creating commit now also records `taskId:callId` in the parent's `mars.side-chat-index` (`requests`), and `createSideChat({ requestKey })` returns the recorded side chat. Before, a stop after the commit but before the tool memo could create a second side chat on replay. `check-side-chats.mjs` proves the same key returns the same id and a new key makes a new one (fails on the old code).
- `plan_update`: steps are trimmed in `preparePlan`, before validation, so a step of only spaces is refused instead of saved as an empty line. `check-plans.mjs` covers it (fails on the old code) and now closes and reopens the store to prove the plan survives a restart.
- `/design-system` has a Plan specimen (in progress and finished) using the real `PlanCard`. Its styles moved from `thread.css` to `components/ai/plan-card.css`, imported by the component.
- Correction to the plan entry above: recovery after the workflow_start redirect was not demonstrated; the first call was already right.

## 2026-10-22 Gateway: one Mars, many clients (codex/gateway-sweep)

- Research in docs/research (gateway designs, Telegram and Discord limits, Harness²), spec in docs/GATEWAY.md, ADR in DECISIONS.md.
- `packages/pi-host/gateway/`: core (routing, owner allowlist, pairing codes, audit, idempotent admission, follow-up queue, commands /new /sessions /switch /status /stop /steer /help, durable chunked outbox), one chunker that keeps code fences balanced, and HTTP API, Telegram (fetch long polling) and Discord (built-in WebSocket gateway with resume) adapters. Adapters run under a supervisor that restarts a failed one with backoff. All state is Pi documents.
- Host: `/api/gateway` routes (status, pairings, unbind, HTTP API messages), `gateway_status` agent tool, conversation rows carry `channel`, web replies in a linked conversation also reach the chat, and a chat message with no model signed in gets a plain "connect a provider" reply instead of a silent failure. Telegram and Discord are off unless turned on by environment.
- UI: Settings, Gateway (chat apps with health and failure reason, pending pairings with Approve and Reject and a warning, linked chats that open their conversation, recent activity without message text); a channel mark after Recents titles; a Gateway specimen on /design-system; fixture data.
- Checks: `check-gateway.mjs` (real harness, scripted model, fake Telegram and Discord: start in Telegram, continue on the web, continue in Telegram; duplicate delivery; busy queue; commands; pairing; audit; 429 and 403; chunking; Discord resume; restart keeps bindings, approvals, queued replies and in-flight answers), mutation-checked 5 of 5. `check-gateway-host.mjs` boots the real host with a fake Telegram. `tests/gateway-ui-check.mjs` in the browser, `tests/gateway.test.mjs` unit tests.

## 2026-10-22 Harness loop: versioned guide and tool text, scored on dev, promoted only if held-out holds

- `packages/pi-host/harness/` holds content-hashed harness config versions (`{ id, parent, systemGuide, toolOverrides, contextNotes }`, written once, refused if hand-edited), a runner that scores a config with local Ollama `qwen2.5:1.5b` on the real tool dump plus overrides, a dev set (23 tasks) and a separate frozen held-out set (15 tasks). Spec in `docs/HARNESS-LOOP.md`.
- The proposer has two scopes. A general rule adds an "Answering" paragraph to the guide when most dev misses are prose answers. A tool rewrite has the local model write guidance for the tool with the most dev misses, keeping its summary and Example lines and passing the tool-quality rules. It never imports or receives held-out text.
- Promotion needs at least +2 fully correct dev runs over the parent and no drop on held-out. Each score carries config id, set, model, tools hash and runs, and mismatched scores are refused. Nothing edits HOST-GUIDE.md or tool files. The loop changes only its own parent config.
- `check-harness-loop.mjs` (no model, no network) covers the rule, a mutation run without the held-out guard (it then promotes a regression), id stability and tamper refusal, and held-out isolation in a full fake round. Manual mutations of the id hash and of the round (leaking held-out misses to the proposer) each failed the check.
- Seven real rounds at 3 runs per task are in `.agents/goals/harness-rounds.tsv`. Round 1 promoted the Answering paragraph (dev 30 to 45 of 69, held-out 14 to 21 of 45). Round 4 promoted a `worker_stop` rewrite at +3 dev and +1 held-out, which is inside the observed noise. Five other candidates were kept out. No model weights changed.
- Gate: 32 of 35 host checks (the same three Mac-only failures), syntax and boundaries pass.

## 2026-10-22 Adopt the harness loop's first promotion

- HOST-GUIDE.md starts with an "Answering" paragraph (call the tool first; do not describe a call or invent its result). The harness loop promoted it in round 1 (config c8b8ffde0ff1); `harness/confirm.mjs` then re-scored parent and candidate on the held-out set four times, interleaved: 9 to 15 versus 21 to 27 fully correct of 45, no overlap. The round-4 tool override was inside the noise band and is not adopted. docs/HARNESS-LOOP.md "Adopting a config".
- Gateway follow-ups: `/status` lists running helpers, `/steer`, typing kept up for the whole answer, one delivery per shared answer, Discord without privileged intents (server messages need a mention), research index with ranked decisions, host guide section on chat apps, two gateway questions in the small-model eval.
