# Gateway designs for a persistent agent

Research date: 22 October 2026. Sources are pinned to the commits I read: Hermes Agent `7162533`, OpenClaw `85c2635`, OpenCode `681156c` (`dev` branch), Codex `d138398`, and claude-plugins-official `d1adba4`. Live documentation pages were read on the same day. "Not found" means I searched the pinned source or documentation and did not find it. It does not mean the feature is absent.

## Summary

The two chat-first gateways (Hermes and OpenClaw) agree on most of the hard parts. Each one builds a deterministic session key from platform, chat type, chat id and thread. Unknown DM senders are denied by default, and the owner approves them with a short pairing code. Each platform event passes through dedup before it reaches the agent. Outbound text is split to each platform's limit by one shared chunker. Accepted work and undelivered replies survive a restart. They differ on busy behaviour. Hermes redirects the active turn by default ([Hermes busy modes][h-msg-busy]). OpenClaw steers by default and queues when it cannot steer ([OpenClaw queue defaults][o-queue-def]).

The two coding-agent servers (OpenCode and Codex app-server) do not have chat platforms in core. They have the cleanest client protocols. A session or thread has a server-generated id. Input carries a client message id. Busy input is either steered into the active turn or queued in durable storage. Events stream over SSE or JSON-RPC notifications ([OpenCode inbox][oc-delivery], [Codex turns][x-doc]).

Claude Code is the odd one out. Its chat bridges are MCP "channel" servers that push events into one open session. Events sent while Claude is busy are batched into the next turn, and nothing arrives when the session is closed ([Channels reference][c-chref-notif]).

For Mars, the useful shape is a host-owned gateway that writes every inbound platform event to Pi as one durable, idempotent admission. That matches the existing rule that the host "routes each accepted input once using requestId" ([Mars architecture][m-arch]). The gateway owns routing, access and outbound delivery. Pi keeps ownership of conversations.

## Hermes Agent (Nous Research)

**Shape.** One gateway process runs platform adapters, a per-chat session store, the agent and a cron ticker ([architecture][h-msg-arch]). Every messaging platform is a plugin adapter that extends `BasePlatformAdapter`. An API server and webhooks are further adapters ([adapters][h-int-adapters]).

**Session key.** The key is `agent:{namespace}:{platform}:{chat_type}[:{chat_id}][:{thread_id}][:{participant_id}]`, for example `agent:main:telegram:dm:12345` ([key rules][h-life-key]). Groups isolate each participant by default (`group_sessions_per_user: true`). Threads are shared by default (`thread_sessions_per_user: false`). The docs say never to construct keys by hand and always to use `build_session_key()` ([key format][h-int-key]). A `sessions.json` file maps each key to its current session id. `/new` creates a new id. `/resume` repoints the key with a compare-and-swap guard ([store methods][h-life-store]). Conversations do not reset on idle or at a daily boundary ([continuity][h-msg-cont]).

**Identity and pairing.** The gateway denies everyone not on an allowlist or paired ([security][h-msg-sec]). An unknown DM sender gets a one-time code. The owner runs `hermes pairing approve telegram <CODE>`. Codes expire after an hour and are rate-limited ([DM pairing][h-msg-pair]). Pairing state persists across restarts ([pairing flow][h-int-auth]). An optional admin and user split gates slash commands per scope ([tiers][h-msg-admin]).

**Busy behaviour.** `display.busy_input_mode` has three values. `interrupt` is the default and redirects the active turn at the next tool-result boundary. `queue` runs each follow-up as its own later turn. `steer` injects the text after the next tool call ([busy modes][h-msg-busy]). Two guards handle this. The adapter queues and sets an interrupt event. The runner lets `/stop`, `/new`, `/queue`, `/status`, `/approve` and `/deny` through inline ([message guard][h-int-guard]).

**Streaming and chunking.** Each adapter declares `max_message_length` for "smart chunking" ([adapter template][h-adapter]). Telegram is 4096 and Discord is 2000 ([Telegram limit][h-tg-limit], [Discord limit][h-dc-limit]). Telegram streaming can use native drafts, `editMessageText` edits or no streaming at all ([transports][h-tg-stream]). Inbound text bursts are merged per session key after a quiet window, because clients split long pastes ([batching][h-batch]).

**Dedup.** Telegram suppresses repeated `update_id`s in memory (the last 4096 admissions). The docs state plainly that a restart can let an old update through ([repeated updates][h-tg-dedup]). Discord uses a TTL cache of 2000 ids for 300 s because RESUME replays events ([dedup class][h-dedup], [Discord use][h-dc-dedup]). The HTTP API is the exception. In canonical mode an `Idempotency-Key` is a durable admission identity, and reusing it with different fields returns 409 `admission_conflict` ([idempotency][h-api-idem]).

**Persistence.** A delivery ledger in `state.db` stores final replies around each send. It redelivers after a crash with at-least-once semantics, and it labels a possibly duplicated reply rather than resending it silently ([delivery][h-msg-deliv]). Turns that were in flight are flagged `restart_interrupted` and resumed once after restart ([resume][h-msg-resume]).

**Adapter contract.** `connect()`, `disconnect()`, `send(chat_id, content, reply_to, metadata) -> SendResult` and `get_chat_info()`. Inbound events are normalised to `MessageEvent` and passed to `handle_message()`. Registration declares requirement checks, allowlist env names, max message length and a platform prompt hint ([adapter template][h-adapter]).

## OpenClaw (formerly Clawdbot, Moltbot)

The project went through the names Warelay, Clawdbot and Moltbot before OpenClaw ([vision][o-vision]).

**Session key.** Each session key is a bucket that holds context and controls concurrency ([terms][o-route-terms]). By default DMs from every channel collapse to `agent:<agentId>:main`. Groups use `agent:<agentId>:<channel>:group:<id>`. Threads append `:thread:<id>`, and Telegram topics append `:topic:<id>` ([key shapes][o-route-keys]). `session.dmScope` can be `main`, `per-peer`, `per-channel-peer` (recommended when several people message the bot) or `per-account-channel-peer`. `session.identityLinks` maps one person's identities to a shared peer ([DM isolation][o-sess-dm]). When `allowFrom` has one entry, non-owner DMs cannot overwrite the main session's reply route ([route pinning][o-route-pin]).

**Identity and pairing.** `dmPolicy` can be `pairing` (the default), `allowlist`, `open` or `disabled` ([access control][o-acl]). Pairing codes are 8 characters with no ambiguous letters. They expire after an hour, and each channel account can have at most 3 pending. The unknown sender's message is **not processed** until approval. Approval happens in the Control UI or with `openclaw pairing approve <channel> <code>`, and it grants DM access only ([pairing][o-pair]). State lives in SQLite tables `channel_pairing_requests` and `channel_pairing_allow_entries` ([pairing state][o-pair-state]).

**Busy behaviour.** A lane-aware FIFO queue serialises runs per session ([queue][o-queue-how]). Defaults are `mode: "steer"`, a 500 ms debounce, `cap: 20` and `drop: "summarize"` ([defaults][o-queue-def]). The modes are `steer`, `followup`, `collect` (coalesce into one follow-up) and `interrupt`. Channels on durable ingress, including Discord and Telegram, keep separate follow-up turns because each message owns its own admission lifecycle. Another person's steer is refused by default ([modes][o-queue-modes]).

**Streaming and chunking.** There is "no true token-delta streaming" to channels. Block streaming sends finished blocks, and preview streaming edits one temporary message ([streaming][o-stream]). `textChunkLimit` defaults to 4000. The chunker prefers paragraph, then newline, then sentence, then whitespace breaks. It never splits inside a code fence; a forced split closes and reopens the fence ([chunker][o-chunk]).

**Dedup.** An in-memory cache keyed by agent, channel route and message id lasts 20 minutes or 5000 entries ([inbound dedupe][o-dedupe]). Durable ingress enqueues the raw envelope before the transport ack. Its key is `(queue_name, event_id)`, and completion tombstones the row so a late redelivery is rejected durably ([durable ingress][o-ingress]). Inbound debounce merges rapid text and skips control commands ([debounce][o-debounce]).

**Persistence.** History, accepted follow-ups, interrupted main turns, the outbound delivery queue and cron all live in SQLite and survive restart. Accepted inputs replay in acceptance order and are never started twice ([restart table][o-restart]). Messages that arrive during the drain window are rejected rather than queued into a dying process ([not resumed][o-restart-not]).

**Adapter contract.** A channel plugin owns config, DM policy, pairing, the mapping from provider ids to chats and threads, outbound sends and threading. Core owns the shared message tool, the outer session-key shape, `:thread:` bookkeeping and dispatch ([plugin owns][o-plugin]).

## OpenCode server mode

**Shape.** `opencode serve` runs a headless HTTP server with an OpenAPI 3.1 spec. The TUI is just one client of it ([server][oc-server]). Chat platforms are not in core. The ecosystem lists third-party bots such as a Discord bot built on the SDK ([ecosystem][oc-eco]).

**Session key.** Sessions have server-generated ids, with parent and child sessions, fork, abort and status endpoints ([sessions API][oc-sessions]). There is no channel-derived key. That is "not found" in core.

**Identity.** HTTP basic auth through `OPENCODE_SERVER_PASSWORD` ([auth][oc-auth-doc]). Pairing links issue random codes with a 5 minute TTL that become signed session tokens ([pairing][oc-pairing], [tokens][oc-auth]). This pairs devices to the server. It does not pair chat users.

**Busy behaviour.** The published docs describe `POST /session/:id/message` (waits) and `prompt_async` (returns 204) ([messages][oc-messages]). On `dev`, the V2 API has `POST /api/session/{id}/prompt` with "durable admission, delivery mode" ([V2 audit][oc-audit]). Its body takes an optional `id` and `delivery: "steer" | "queue"` ([schema][oc-delivery]), and `steer` is the default ([prompt][oc-prompt]). Revert operations fail with `BusyError` while the session is active ([busy][oc-busy]). An interrupt with `resume` promotes waiting steers and leaves queued next-turn prompts parked ([execution][oc-exec]).

**Dedup.** Inbox admission looks up the supplied id. An exact repeat returns the stored row. A repeat with different content raises `LifecycleConflict` ([admit][oc-admit]). The inbox is a SQLite table ([table][oc-inbox-sql]).

**Streaming.** `GET /event` is an SSE stream that starts with `server.connected` and then emits bus events ([events][oc-events]). The SDK wraps it as `client.event.subscribe()` ([SDK][oc-sdk]). I did not find replay from a cursor or `Last-Event-ID` in the event feed ([event feed][oc-feed]). Chunking for platform limits is not applicable.

## Claude Code (Agent SDK, headless, Remote Control, Channels)

**Session key.** Every session has an id returned on the result message, and `resume` takes that id. `continue` picks the most recent session in the directory. `fork` copies the history ([sessions][c-sess]). Sessions are JSONL files under `~/.claude/projects/<encoded-cwd>/`. To resume on another host you move the file ([across hosts][c-sess-hosts]). Headless `claude -p` accepts `--continue` and `--resume` ([headless][c-headless]).

**Multi-client.** Remote Control shows one local session in the browser and the mobile app, and keeps the conversation in sync across devices ([Remote Control][c-rc]). Channels are MCP servers that declare the `claude/channel` capability and push `notifications/claude/channel` with `content` and `meta`. Replies go out through a reply tool ([reference][c-chref]).

**Identity and pairing.** Each channel keeps a sender allowlist. Telegram and Discord bootstrap it by pairing, and no channel runs until `--channels` opts it in ([security][c-ch-sec]). The docs say to gate on the sender id, not the room id, because anyone in an allowlisted group could otherwise inject text ([gating][c-chref-gate]). The Telegram plugin replies with a 6-character code, drops the message and stores state in `access.json` ([access][c-tg-access]).

**Busy behaviour.** Channel events "queue into the session". Events that arrive while Claude is busy are delivered together on the next turn ([notification format][c-chref-notif]). The SDK's streaming input mode queues messages that run in order and can be interrupted ([streaming input][c-stream]).

**Streaming and chunking.** Headless `stream-json` with `--include-partial-messages` emits tokens as NDJSON events ([headless][c-headless]). The Telegram plugin splits replies at 4096 characters, by length or by paragraph ([chunk][c-tg-chunk]).

**Dedup and persistence.** Inbound dedup is not found. Channel events only arrive while the session is open ([channels][c-ch]).

## OpenAI Codex app-server

**Shape.** JSON-RPC 2.0 without the `jsonrpc` header. It runs over stdio JSONL by default. WebSocket and Unix socket are experimental ([app-server][x-doc],
[listen flag][x-main]). The model has three levels. A thread is a conversation,
a turn is one input plus the agent's work, and an item is one event. `thread/start`, `thread/resume` and `thread/fork` select the thread. `turn/start`, `turn/steer` and `turn/interrupt` drive it ([app-server][x-doc]).

**Session key.** The server generates the thread id. Clients subscribe per thread. When the last subscriber leaves, the thread unloads after 30 minutes of inactivity ([app-server][x-doc]).

**Identity.** WebSocket auth uses a bearer token. Non-loopback listeners currently accept unauthenticated connections by default, so the docs say to configure auth ([app-server][x-doc]). Pairing of unknown users is not found.

**Busy behaviour.** `turn/steer` appends input to the in-flight turn. It requires `expectedTurnId` and fails when that is not the active turn ([steer params][x-steer]). `thread/queue/add` holds input for later. It takes a required `clientUserMessageId` ([queue params][x-queue]). `thread/queue/start` refuses with "thread already has an active or pending turn" ([queue start][x-queue-start]). The queue service is backed by SQLite ([queue service][x-queue-svc]).

**Streaming.** Notifications include `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed` and `turn/completed`. Full ingress queues answer `-32001` "Server overloaded" ([app-server][x-doc]).

**Dedup.** `clientUserMessageId` is optional on `turn/start` and `turn/steer` ([turn params][x-turn]). It is carried as the input's `client_id`. I did not find a server-side duplicate check on it ([queue service][x-queue-svc]).

## Comparison

Sources for each cell are in the sections above.

| Concern | Hermes | OpenClaw | OpenCode | Claude Code | Codex app-server |
| --- | --- | --- | --- | --- | --- |
| Session key | `agent:ns:platform:type:chat[:thread][:user]` mapped to a session id | `agent:id:main` for DMs by default, `agent:id:channel:group:id[:thread:id]` | Server id | Server UUID, JSONL file | Server thread id |
| Unknown users | Deny, pairing code, 1 h | Deny until paired, 8 chars, 1 h, 3 pending | Server password, device pairing link | Sender allowlist, 6-char pairing | Bearer token. Pairing not found |
| Busy input | `interrupt` default, `queue`, `steer` | `steer` default, `followup`, `collect`, `interrupt` | `steer` default, `queue` | Batched into next turn | `turn/steer` with expected turn, durable queue |
| Control bypass | `/stop` `/new` `/approve` inline | Control commands skip debounce | `abort` endpoint | Not found | `turn/interrupt` |
| Streaming | Draft or edit per platform | Blocks or edited preview, no token deltas | SSE bus events | `stream-json` partials | JSON-RPC deltas |
| Chunking | Per-adapter max length | Shared chunker, fence-safe, 4000 default | N/A | Plugin splits at 4096 | N/A |
| Inbound dedup | Memory per adapter, durable for API keys | Memory 20 min, durable `(queue, event_id)` tombstones | Durable inbox id, conflict on mismatch | Not found | Not found |
| Restart | Delivery ledger, resume in-flight once | SQLite inputs, delivery queue, ordered replay | Durable inbox | Session files, channels need open session | Threads persist, resume by id |
| Adapter contract | `connect`, `send`, `MessageEvent` plugin | Plugin owns access and grammar, core owns key shape | HTTP and SDK clients | MCP channel server plus reply tool | JSON-RPC client |

## Ranked decisions for Mars

Ranked by how much each one constrains the rest of the design.

| # | Decision | Adopt/Adapt/Reject | Evidence |
| --- | --- | --- | --- |
| 1 | Every inbound event becomes one durable Pi admission keyed `requestId = hash(channel:account:eventId)`. An exact repeat returns the first result, and the same key with different content is a conflict. Ack the platform only after the write. | Adopt | [OpenClaw durable ingress][o-ingress], [OpenCode admit][oc-admit], [Hermes idempotency][h-api-idem], [Mars requestId][m-arch] |
| 2 | Reject in-memory TTL dedup as the only guard. Hermes documents that restarts let old updates through. | Reject | [Hermes Telegram dedup][h-tg-dedup], [Hermes dedup class][h-dedup] |
| 3 | Route key `mars:<channel>:<account>:<chatType>:<chatId>[:thread:<id>]`, built by one function. A binding table maps it to the Pi conversation id. `/new` repoints the binding with compare-and-swap. | Adapt | [Hermes key builder][h-int-key], [Hermes store][h-life-store], [OpenClaw shapes][o-route-keys] |
| 4 | Isolate each chat by default (`per-channel-peer`). Add explicit identity links later if the owner wants one shared thread across Discord and Telegram. Do not default to OpenClaw's shared `main` DM. | Adapt | [OpenClaw DM isolation][o-sess-dm], [Hermes DM rules][h-life-key] |
| 5 | Unknown DM senders are denied, and their text never reaches Pi. They get an 8-character code that expires after an hour, with at most 3 pending per account. The owner approves in the web UI or CLI. | Adopt | [OpenClaw pairing][o-pair], [Hermes pairing][h-msg-pair], [Claude channels][c-ch-sec] |
| 6 | In v1 only the owner's own platform accounts can be paired. Mars has full VM control, and the pairing systems above have no tool gating, so a paired stranger gets a shell. | Adapt | [Hermes allow-all warning][h-msg-sec], [Hermes tiers gate commands only][h-msg-admin], [Mars host guide][m-guide] |
| 7 | Gate on sender id, never on chat or room id. | Adopt | [Claude gating][c-chref-gate] |
| 8 | Busy behaviour defaults to a durable follow-up queue, one turn per message in FIFO order, capped per session. `/steer` is explicit and same-sender only. `interrupt` is the `/stop` command, not a mode. | Adapt | [OpenClaw modes][o-queue-modes], [Hermes queue mode][h-msg-busy], [Codex queue][x-queue] |
| 9 | `/stop`, `/status`, `/new` and approvals bypass the queue and debounce. | Adopt | [Hermes guard][h-int-guard], [OpenClaw debounce][o-debounce] |
| 10 | Steer only with a turn precondition (`expectedTurnId`) so a late steer can never land in the next turn. | Adopt | [Codex steer][x-steer] |
| 11 | Use one core chunker with per-channel limits (Discord 2000, Telegram 4096). Break at paragraph, newline, sentence, whitespace, then hard. Never split inside a code fence. | Adopt | [OpenClaw chunker][o-chunk], [Hermes limits][h-dc-limit] |
| 12 | Chat platforms get the final reply plus a typing signal in v1. Edit-in-place previews come later. Web UI and HTTP API clients get native events over SSE. | Adapt | [OpenClaw streaming][o-stream], [Hermes transports][h-tg-stream], [OpenCode events][oc-events] |
| 13 | Run a durable outbound delivery ledger. It is at-least-once, has bounded retries and labels possible duplicates. | Adopt | [Hermes delivery][h-msg-deliv], [OpenClaw restart table][o-restart] |
| 14 | On restart, replay accepted inputs per session in acceptance order, once. Reject new input while draining. | Adopt | [OpenClaw restart][o-restart], [OpenClaw drain][o-restart-not], [Hermes resume][h-msg-resume] |
| 15 | Keep the adapter contract small. It covers `start`, `stop`, a normalised `InboundEvent {channel, account, eventId, sender, chat, thread, text, attachments}`, `send(target, parts) -> receipts`, and capabilities (max length, edit, threads, typing). Core owns keys, access, queue and chunking. | Adopt | [OpenClaw plugin split][o-plugin], [Hermes adapter][h-adapter] |
| 16 | The HTTP API uses Mars-native session routes with `Idempotency-Key` and SSE. Do not add an OpenAI-compatible facade. | Adapt | [OpenCode V2 prompt][oc-audit], [Hermes API modes][h-api-idem] |
| 17 | Merge a split long paste with a short quiet window, about 300 ms on Telegram. Skip this for control commands. | Adapt | [Hermes batching][h-batch], [OpenClaw debounce][o-debounce] |
| 18 | Web and API clients subscribe per session. Detaching never stops the run, which matches Mars's current browser rule. | Adopt | [Codex subscriptions][x-doc], [Mars architecture][m-arch] |
| 19 | Do not build chat bridges as session-attached MCP servers. Their events need an open session and arrive in batches. | Reject | [Claude notification format][c-chref-notif], [Claude channels][c-ch] |
| 20 | Defer per-channel model and persona overrides. They are not needed for one owner. | Reject | [Hermes channel overrides][h-msg-overrides] |

<!-- Hermes Agent -->
[h-msg-arch]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L70
[h-msg-deliv]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L280
[h-msg-cont]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L313
[h-msg-overrides]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L326
[h-msg-sec]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L350
[h-msg-pair]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L376
[h-msg-admin]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L392
[h-msg-busy]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L428
[h-msg-resume]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/index.md?plain=1#L868
[h-int-key]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-internals.md?plain=1#L481
[h-int-guard]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-internals.md?plain=1#L495
[h-int-auth]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-internals.md?plain=1#L505
[h-int-adapters]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-internals.md?plain=1#L555
[h-life-store]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-session-lifecycle.md?plain=1#L171
[h-life-key]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/gateway-session-lifecycle.md?plain=1#L211
[h-adapter]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/developer-guide/adding-platform-adapters.md?plain=1#L92
[h-tg-dedup]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/telegram.md?plain=1#L132
[h-tg-stream]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/messaging/telegram.md?plain=1#L1069
[h-api-idem]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/website/docs/user-guide/features/api-server.md?plain=1#L74
[h-dedup]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/gateway/platforms/helpers.py#L20
[h-dc-dedup]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/plugins/platforms/discord/adapter.py#L1329
[h-batch]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/gateway/platforms/base.py#L2467
[h-tg-limit]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/plugins/platforms/telegram/adapter.py#L524
[h-dc-limit]: https://github.com/NousResearch/hermes-agent/blob/7162533fccd9f76a65c91e292d5dac0d7f8a395b/plugins/platforms/discord/adapter.py#L1225
<!-- OpenClaw -->
[o-vision]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/VISION.md?plain=1#L13
[o-route-terms]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/channels/channel-routing.md?plain=1#L15
[o-route-keys]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/channels/channel-routing.md?plain=1#L40
[o-route-pin]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/channels/channel-routing.md?plain=1#L76
[o-sess-dm]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/session.md?plain=1#L111
[o-acl]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/gateway/security/access-control.md?plain=1#L11
[o-pair]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/channels/pairing.md?plain=1#L31
[o-pair-state]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/channels/pairing.md?plain=1#L127
[o-queue-how]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/queue.md?plain=1#L18
[o-queue-def]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/queue.md?plain=1#L29
[o-queue-modes]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/queue.md?plain=1#L41
[o-stream]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/streaming.md?plain=1#L10
[o-chunk]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/streaming.md?plain=1#L158
[o-dedupe]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/messages.md?plain=1#L29
[o-debounce]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/concepts/messages.md?plain=1#L33
[o-ingress]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/plugins/sdk-channel-plugins/durable-ingress.md?plain=1#L41
[o-restart]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/gateway/restart-recovery.md?plain=1#L77
[o-restart-not]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/gateway/restart-recovery.md?plain=1#L1528
[o-plugin]: https://github.com/openclaw/openclaw/blob/85c263564848e6b0246b5358e737e42ea867eabd/docs/plugins/sdk-channel-plugins.md?plain=1#L19
<!-- OpenCode -->
[oc-server]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/server.mdx?plain=1#L1
[oc-auth-doc]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/server.mdx?plain=1#L37
[oc-sessions]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/server.mdx?plain=1#L146
[oc-messages]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/server.mdx?plain=1#L168
[oc-events]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/server.mdx?plain=1#L272
[oc-sdk]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/sdk.mdx?plain=1#L448
[oc-eco]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/web/src/content/docs/ecosystem.mdx?plain=1#L66
[oc-audit]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/V2_HTTP_API_AUDIT.md?plain=1#L154
[oc-delivery]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/schema/src/session-inbox.ts#L11
[oc-prompt]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/core/src/session/prompt.ts#L50
[oc-admit]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/core/src/session/inbox.ts#L155-L200
[oc-inbox-sql]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/core/src/session/sql.ts#L125
[oc-busy]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/core/src/session/session.ts#L334
[oc-exec]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/core/src/session/execution.ts#L150-L166
[oc-feed]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/server/src/event-feed.ts
[oc-pairing]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/server/src/pairing.ts#L7
[oc-auth]: https://github.com/sst/opencode/blob/681156c82fcdd02a64dee0e81967ea35e5c8b886/packages/server/src/auth.ts#L32
<!-- Claude Code -->
[c-sess]: https://code.claude.com/docs/en/agent-sdk/sessions#choose-an-approach
[c-sess-hosts]: https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts
[c-stream]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
[c-headless]: https://code.claude.com/docs/en/headless
[c-rc]: https://code.claude.com/docs/en/remote-control
[c-ch]: https://code.claude.com/docs/en/channels
[c-ch-sec]: https://code.claude.com/docs/en/channels#security
[c-chref]: https://code.claude.com/docs/en/channels-reference
[c-chref-notif]: https://code.claude.com/docs/en/channels-reference#notification-format
[c-chref-gate]: https://code.claude.com/docs/en/channels-reference#gate-inbound-messages
[c-tg-access]: https://github.com/anthropics/claude-plugins-official/blob/d1adba47161a271799de7b548225d929310046bd/external_plugins/telegram/ACCESS.md?plain=1#L5
[c-tg-chunk]: https://github.com/anthropics/claude-plugins-official/blob/d1adba47161a271799de7b548225d929310046bd/external_plugins/telegram/server.ts#L363-L366
<!-- Codex -->
[x-doc]: https://developers.openai.com/codex/app-server/
[x-main]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/app-server/src/main.rs#L42
[x-turn]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L170-L177
[x-steer]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L317-L345
[x-queue]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L941
[x-queue-start]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L208-L222
[x-queue-svc]: https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/ext/queue/src/service.rs#L89
<!-- Mars -->
[m-arch]: ../ARCHITECTURE.md
[m-guide]: ../../packages/pi-host/HOST-GUIDE.md
