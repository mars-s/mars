# Research for the gateway sweep (22 October 2026)

Four notes, each with its own sources:

- [gateway-designs.md](gateway-designs.md): Hermes Agent, OpenClaw, OpenCode server, Claude
  Code channels and the Codex app-server, compared on session keys, pairing, busy handling,
  chunking, dedup and restart.
- [telegram-discord.md](telegram-discord.md): Telegram Bot API and Discord Gateway and REST
  limits from the official docs, plus what a fake server must emulate.
- [pi-durable-for-gateway.md](pi-durable-for-gateway.md): what Pi Durable 1.3.0 already
  provides, so the gateway adds no second store.
- [harness-squared.md](harness-squared.md): the Harness² paper (arXiv 2610.14224, Google Cloud
  AI Research with Northwestern) and the closest related work, Meta-Harness first.

## Ranked decisions, and what this branch did

Most important first. "Built" means the code and its check are on `codex/gateway-sweep`.

| # | Decision | Verdict | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Every inbound event is one durable Pi admission keyed by channel, account and event id; ack the platform after the write | Adopt | Built | gateway-designs 1, pi-durable-for-gateway; `check-gateway.mjs` sections 4 and 12 |
| 2 | No in-memory-only dedup | Reject the alternative | Built (Pi `requestId` plus `mars.gateway.seen`) | gateway-designs 2 |
| 3 | All gateway state in Pi documents, no Postgres or second scheduler | Adapt (Page said Postgres) | Built | ADR "Gateway, many clients on Pi's own state" |
| 4 | Route key per chat (`channel:account:type:chat[:thread:id]`), built by one function; `/new` and `/switch` rebind | Adapt | Built | gateway-designs 3, 4 |
| 5 | Owner-only by sender id; unknown senders get an 8-character code (1 hour, 3 pending), owner approves in the web UI with a power warning | Adopt | Built | gateway-designs 5 to 7 |
| 6 | Busy conversation: follow-up queue; `/steer` explicit; `/stop` instead of an interrupt mode; commands bypass the queue | Adapt | Built | gateway-designs 8, 9; `InboxDoc` mode assertion |
| 7 | One chunker with per-platform limits that never leaves a code fence open | Adopt | Built | gateway-designs 11 |
| 8 | Durable outbound queue, at least once, `retry_after` honoured, 403 dropped and audited | Adopt | Built | gateway-designs 13, telegram-discord |
| 9 | No new dependencies: Telegram by fetch long polling, Discord by Node WebSocket and fetch | Adopt | Built | telegram-discord |
| 10 | Discord: intents 4609 (no privileged intent), server messages only when they mention the bot; `MESSAGE_CONTENT` opt-in | Adapt | Built | telegram-discord |
| 11 | Discord `nonce` with `enforce_nonce`, `allowed_mentions: { parse: [] }` | Adopt | Built | telegram-discord |
| 12 | Final answer plus a typing indicator in v1; edit-in-place streaming later | Adapt | Built (typing refreshed for the whole answer); streaming not built | gateway-designs 12 |
| 13 | Telegram webhooks, Discord HTTP interactions, discord.js, grammY | Reject for v1 | Not built | telegram-discord |
| 14 | Merge a split long paste after a quiet window | Adapt | Not built (open) | gateway-designs 17 |
| 15 | Harness as content-hashed versioned files; frozen dev and held-out sets; keep-parent default; promote on a dev margin with no held-out loss | Adopt / Adapt | Built | harness-squared; docs/HARNESS-LOOP.md |
| 16 | Rerun the owner's live tasks to probe harness edits (Harness² per-task loop) | Reject | Not built | harness-squared (it can repeat external actions) |
| 17 | Promote on self-judged behaviour without a held-out score | Reject | Not built | harness-squared |
