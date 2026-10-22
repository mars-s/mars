# Decisions

## 20 October 2026: replace the earlier ZCode direction

The owner explicitly requested retiring ZCode, old Mars trusted-core/workbench and
DeepSeek, keeping Pi Durable plus Mars UI in one installable public mars repo.
This supersedes historical ZCode/provider/layer rules and model pins. Public Mars source history remains in Git. Full private UI and local-only
history is in the private backup bundle, not the public migration ancestry.
No legacy application code is part of the active workspace.

## Native state stays native

Keep upstream Pi Durable1.3.0 pinned as a dependency. Custom host adapters own
HTTP, immutable plugin installation, image files and deployment. Native Pi owns
conversations, tasks, checkpoints and usage. Do not vendor or fork the SDK as an
unnecessary third workspace. The UI stays on assistant-ui with its real runtime.

## One checkout and one dependency lock

Use npm workspaces for apps/ui and packages/pi-host, one pinned root lockfile,
portable root commands, and optional generated Linux user services. New installs
start with empty private XDG data. Existing installations use explicit MARS_PI_ROOT
and preserve original secrets/state. Hot reload is for development; production
start uses a tested build. Host self-deployment keeps staged checks and rollback.

## Workbench terminal uses a Python PTY bridge and long polling

The workbench brief asked for node-pty over a WebSocket. node-pty 1.1.0 failed
`posix_spawnp` on the owner's Mac and has no Linux prebuild, and the Next dev proxy
does not forward WebSocket upgrades. The terminal is `python3 pty-bridge.py` per
session with HTTP long polling (20 s). It works on macOS, Debian and through every
proxy in use. Evidence: `.agents/goals/workbench-log.tsv`, `check-workbench-terminal.mjs`.

## 22 October 2026: Gateway, many clients on Pi's own state

The Project Mars page (18 October, written before the Pi rewrite) names Postgres for
authoritative state, Strands for reasoning, Cordis for plugins and Temporal for
workflows. The repo has since chosen Pi Durable as the only native state owner (above).
The gateway follows the repo, not the page: bindings, the owner allowlist, pairings, the
outbound queue and the audit log are Pi session documents (`mars.gateway`,
`mars.gateway-audit`), and each conversation's channel is a conversation document
(`mars.channel`). No Postgres, no second scheduler. Evidence: docs/GATEWAY.md,
docs/research/gateway-designs.md decisions 1 to 15, `check-gateway.mjs`.

- Inbound messages are admitted once: Pi `requestId = gw:<channel>:<account>:<eventId>`
  (Pi keys request ids per conversation) plus a recent-keys list in `mars.gateway` for
  routing after `/new`. In-memory dedup alone is rejected (Hermes documents restart leaks).
- Busy conversations use Pi's follow-up queue; `/steer` is explicit. Interrupt is `/stop`.
- Only the sender id is checked. v1 allows the owner's own accounts and senders the owner
  approves by pairing code; approval grants full owner power, and the UI says so.
- No new dependencies: Telegram by fetch long polling, Discord by Node's WebSocket and
  fetch. Telegram and Discord start only with `MARS_GATEWAY_TELEGRAM=1` /
  `MARS_GATEWAY_DISCORD=1`, never in staging, so no check or staged boot reaches a live bot.
- Page differences recorded rather than adopted: Strands/Cordis (Pi extensions and the
  plugin registry fill those roles), Hindsight memory (not in this sweep), Temporal (Pi
  tasks and workflows cover durable jobs today).

## 22 October 2026: Self-edit trust boundary is enforced in the tools, not the OS

The Project Mars page asks that self-improvement can never modify its evaluator, deploy
gate, audit trail or approval mechanism. Mars runs the agent as the owner with full shell
access (owner-authorised VM control, AGENTS.md), so a hard guarantee would need the gate
files outside its reach. This branch enforces the boundary in the agent's own change and
deploy tools instead: `self_edit_*` and the agent's `host_deploy` refuse any change to the
files in `protected-files.mjs`, and `host_deploy` can no longer skip checks. The owner's
`npm run host:deploy` stays unlimited. Moving the gates to a separate user or CI is left to
the owner. Evidence: `check-self-edit.mjs`, `check-self-edit-deploy.mjs`.

## 22 October 2026: Updates from main merge local work, never reset it

The owner asked for a Hermes-style updater: watch main, reconcile deterministically, and
involve an agent only for complicated cases. Hermes autostashes local edits and, on a
diverged checkout, saves a rescue ref and runs `git reset --hard`. Mars does not: on the
server, local commits are mostly merged self-edits, so dropping them is the wrong default.
A clean divergence becomes a merge commit (`git merge-tree` then `commit-tree`, never
touching the checkout until the switch-over). A conflicting one stops and names the files;
the agent path (`mars_update_reconcile_*`) is opt-in and works in a separate worktree. A
protected file may keep one side whole, never a third version.

The update builds the whole install (dependencies, Next build, host runtime) beside the
running one and swaps by rename, because a Next build made in another folder still serves
after a move (checked by hand). The switch-over runs as its own `systemd-run --user` unit
with a journal; `scripts/run.mjs` undoes an interrupted switch-over before either service
starts. Evidence: docs/UPDATES.md, `scripts/test-update.mjs`, `check-updates.mjs`.
