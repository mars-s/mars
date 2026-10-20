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
