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
