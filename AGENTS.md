# Shared agent context (read this first)

Two agents work on this repo and neither owns it. Before changing anything, read
these. They record the current state and the decisions already made.

- `.agents/CONTEXT.md` — current state, standing rules, what is in flight
- `.agents/ROADMAP.md` — stage plan, issue index, wave status
- `.agents/DECISIONS.md` — decisions already taken. Do not relitigate them.
- `.agents/verification.md` — the commands that prove a change works
- `.agents/pstack-models.md` — per-role model pins

Append to `.agents/CHANGELOG.md` in the same commit as any change. A change with
no changelog entry counts as not done. Never silently revert another agent's
work; read its changelog entry first. Do not put secrets in `.agents/`, it is
committed.

The rest of this file is the upstream ZCode contributor guide.

## Core principles

- Before adding or changing behaviour, update the matching spec first, creating the directory if it does not exist. Settle the product rule, the state owner, the interface and the acceptance scenarios before writing code.
- Treat the checked-out source, `package.json` and the architecture policy as the source of truth. Keep only the features, commands and files this repository actually provides. When you delete a feature, remove its references from instructions and skills at the same time.
- When diagnosing a problem, investigate the cause first unless you were explicitly asked to change code. Work from source, logs and runtime evidence, and keep confirmed causes separate from hypotheses that are still unverified.
- Leave local changes that are unrelated to the task alone. Do not restore removed modules or internal dependencies on your own initiative.

## Commands and repository layout

Run `node scripts/check-workspace-freshness.mjs` to check the baseline before you start. The Node version is whatever `mise.toml` pins.

The following commands run from the repository root:

| Purpose | Command |
| --- | --- |
| Type check | `pnpm typecheck` |
| Lint | `pnpm lint` / `pnpm lint:fix` |
| Format check | `pnpm fmt:check` |
| Desktop development | `pnpm dev:desktop` |
| Web development | `pnpm dev:web` |
| Pre-push check | `pnpm verify:pre-push` (lint and architecture check) |
| Architecture check | `pnpm architecture:check --changed` |
| Module reading bundle | `pnpm architecture:context <module-id>` |
| Unused dependencies and exports | `pnpm knip` |
| Export reference lookup | `pnpm dep:refs --list-exports <file>` |

Treat the test entry point as whatever the target package's current `package.json` and actual test files say. Do not assume a unified unit or E2E command exists.

- `packages/desktop`: Electron main, host and renderer.
- `packages/web`, `packages/server`: the web client and server.
- `packages/ui`: shared React components, hooks and Zustand stores.
- `packages/services`: business services. `packages/rpc`: the RPC framework.
- `packages/shared`: shared protocol and types. `packages/client`: the agent client SDK.
- `apps/zcode-cli`: the agent CLI and runtime.
- `CONTEXT.md`: plugin store domain vocabulary. Read it before changing the related UI.
- `DESIGN.md`: the UI design specification. Read it before changing UI.

## Implementation and verification

- For code changes use `.agents/skills/architecture-governance/SKILL.md`. Run the architecture check first, then read the target module's controlled context.
- Avoid duplicated state and multiple write paths. Establish a single owner, the interface, the dependency direction, the event order and the idempotency boundary. Do not use a timeout to paper over a synchronisation problem.
- Add the matching test when behaviour changes. Interactive changes need an E2E scenario. Check that the test and the implementation agree, and actually run whatever verification is available. If you did not run it, or the environment blocked you, say so honestly.
- When fixing a bug, comment in English on the cause and on the reasoning behind the fix. When you find a design flaw, align with the user first instead of accumulating fallback branches.
- For a design that touches state, ordering, remotes or async synchronisation, draw the owners and the event order.
- You must run `pnpm typecheck` and `pnpm lint`, report the real result, and never write an existing failure up as a pass.
- Use async file and network IO. Import across packages through public entry points and respect the existing path aliases.
- Forbidden: the UI calling a repo directly, a service referencing a concrete runtime implementation, cross-domain imports of implementation details, and circular dependencies.

## UI and platform boundaries

- Follow `DESIGN.md`, reuse existing components, and account for layout, interaction, theming and internationalisation across desktop and mobile web.
- Components reach services through `packages/ui/src/hooks/`. Platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), never by calling `window.zcode` directly.
- Handle the differences between desktop, web, local and remote environments through dependency injection, and account for Windows, macOS and Linux.
- Zustand state lives in `packages/ui/src/store/`. Broadcast-synced fields such as theme and locale need loop protection. Local UI state must not be mistaken for a server-side fact.
- A hooks file that contains JSX uses the `.tsx` extension.

## Processes, protocol and remote control

- The desktop app talks to the agent over stdio. A protocol change updates `packages/shared/src/zcode-protocol/index.ts` in the same commit, with strict types and runtime validation.
- Main owns windows, native operations, process scheduling and message forwarding. It does not hold task or session business state.
- Each window uses one window-scoped Local Host. Local workspaces share that Host. Remote workspaces are managed by the connection registry inside the window, with no separate Desktop Remote Host.
- Phone remote control attaches to the desktop's existing Host and reuses the session runtime. It does not start a separate agent, Local Host or remote session for the phone.
- The desktop's `desktop-continuous` live path and the phone's `web-remote-replayable` recovery path must be kept clearly distinct. When you change a stream, snapshot, queue or reconnect, verify both semantics.
- The external relay and Main only handle auth, pairing, heartbeat, forwarding and attachment scheduling. They do not store business state such as task queues or snapshots.
- Busy or running input that has been accepted is admitted serially by the CLI/runtime `CommandInbox`. The renderer keeps only unsubmitted drafts and a pending optimistic overlay. The Host owner/lease does the routing.
- Keep the owner/lease model, cross-Host routing and stale-run protection. Do not delete a boundary check on the strength of a single code path.

## Workspace Identity

- `workspaceIdentity` is for identity isolation. `workspacePath` is for file operations, command cwd, Git and path display.
- The identity key is uniformly `workspaceIdentity?.trim() || workspacePath`, used for deduplication, binding, caching, queuing, persistence and request correlation.
- Remote paths pass `workspaceIdentity` and `remoteSessionId` end to end. Do not match on path alone.
- New interfaces keep a local-path fallback. Remote identity reuses the existing construction and parsing helpers; do not hand-roll the format in business code.

## Logging

- The UI uses `packages/ui/src/logger.ts`, not `console.log` or `window.zcode?.log` directly.
- Agent, session and runtime service logs use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics such as raw protocol data, streaming chunks and per-tool-call updates. It is not written to disk in production.
- `info` is for production-relevant events: process and session lifecycle, permission outcomes, and one-time initialisation.
- `warn` is for recoverable problems. `error` is for unrecoverable ones such as a crash, a failed handshake, or lost authentication.
- Never write credentials, real user data or internal service addresses into logs, examples or commits.
