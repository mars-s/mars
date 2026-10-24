# Gateway: one Mars, many clients

Status: spec for the codex/gateway-sweep branch. Research behind each decision is in
`docs/research/gateway-designs.md`, `docs/research/telegram-discord.md` and the ADRs in
`.agents/DECISIONS.md` ("Gateway" entries).

## What it is for

Mars is one persistent agent with many conversations (Pi owns them). The gateway lets the
owner reach those conversations from other clients: Telegram, Discord and a plain HTTP
API, as well as the web UI. A conversation started in Telegram shows in the web UI's
Recents and can be continued there, then continued again from Telegram. A message to a
busy conversation waits its turn and never interrupts other conversations or tasks.

## Parts

```mermaid
flowchart LR
  TG[Telegram adapter] --> GW[Gateway core]
  DC[Discord adapter] --> GW
  API[HTTP API adapter] --> GW
  GW -->|submit, requestId| Pi[Pi conversations]
  Pi -->|answers| GW
  GW --> TG
  GW --> DC
  GW --> API
  UI[Web UI] -->|/api/gateway| GW
```

- **Gateway core** (`packages/pi-host/gateway/core.mjs`): routing, access, commands,
  idempotent admission, outbound delivery and chunking. One per host. It never imports
  a platform library.
- **Adapters** (`packages/pi-host/gateway/adapters/*.mjs`): one per platform. They turn
  platform events into `InboundEvent`s and send text back. Nothing else.
- **State**: Pi documents only (session scope), so there is no second database:
  - `mars.gateway` holds bindings, the owner allowlist, pending pairings and the
    outbound delivery queue.
  - `mars.gateway-audit` holds the latest 500 audit records.
  - Each bound conversation has `mars.channel` (conversation scope) naming its channel,
    for the Recents badge.

## Adapter contract

```js
/** @typedef {{ channel: string, account: string, eventId: string,
 *   sender: { id: string, name?: string }, chat: { id: string, type: 'dm'|'group' },
 *   thread?: string, text: string, at?: number }} InboundEvent */
adapter = {
  channel: 'telegram',            // stable name, also the route key prefix
  limits: { maxText: 4096 },      // the chunker splits replies to this
  start(sink, signal),            // begin receiving; call sink(event) for each message,
                                  // and only acknowledge the platform after sink resolves
  send({ chat, thread, text }),   // deliver one chunk; resolves { messageId } or throws
                                  // an Error with .retryAfterMs (rate limit) or .permanent
  health(),                       // { state: 'running'|'starting'|'stopped'|'failed', detail? }
}
```

The host owns the lifecycle. `start` runs inside a supervisor: if it throws or rejects,
the gateway records the failure, marks the adapter `failed` and restarts it with backoff
(1 s doubling to 60 s). An adapter can never stop Pi, the HTTP server or another adapter.

## Routing

- Route key: `<channel>:<account>:<chatType>:<chatId>[:thread:<threadId>]`, built by one
  function, `routeKey(event)`. Each chat is its own route; Discord and Telegram never share
  a route by accident.
- A **binding** maps a route key to a Pi conversation id. The first owner message on an
  unbound route creates a new top-level conversation titled from the message, binds it,
  and records `mars.channel` on it.
- The web UI is not a route: it opens conversations by id. A conversation bound to
  Telegram is an ordinary conversation, so the web UI can read and continue it. Replies to
  web UI messages in a bound conversation are also sent to the bound chat, so the chat
  stays a complete view of the conversation (see Delivery).

## Access and pairing

- Only the **sender id** is checked, never the chat id, so a group cannot let strangers in.
- A sender is allowed while either of these holds:
  - its id is set in the host configuration (`MARS_TELEGRAM_OWNER`, `MARS_DISCORD_OWNER`;
    the HTTP API's `owner` is always set). These ids are read at each boot and never stored,
    so taking one out of the configuration and restarting Mars stops it, unless it is also
    approved.
  - it is on the approved list in `mars.gateway` (`allow`). Only approving a pairing adds to
    the list, and only the owner's Remove (Settings, Gateway, Allowed senders, or
    `POST /api/gateway/allow/delete`) takes a sender off it. Mars never adds or removes an
    approved sender by itself, apart from the one-time cleanup below.
- Hosts before 2026-10-24 copied the configured ids into the approved list at every boot.
  The first boot after that change removes, once, the copies of every id still configured
  (and the HTTP API's `owner`), with a `removed` audit record for each. From then on only
  the configuration allows those ids, so taking one out and restarting stops it. A copy of
  an id that was already out of the configuration at that boot looks the same as an
  approval, so it stays until the owner removes it in Settings, Gateway.
- A removed sender is treated as unknown again: their next message gets a new pairing code
  and never reaches Pi.
- An unknown sender's text never reaches Pi. They receive one reply with an 8-character
  pairing code (no ambiguous letters). Codes expire after 1 hour; at most 3 are pending
  per channel; a repeat message from the same sender reuses their pending code.
- The owner approves or rejects a code in the web UI (Settings, Gateway). Approval adds
  that sender id to the allowlist. Mars has full VM control, so the UI says plainly that
  approving gives the sender the same power as the owner.
- Every inbound event gets an audit record: time, channel, sender, route, decision
  (`accepted`, `duplicate`, `paired`, `denied`, `command`, `removed`), conversation id. Message text is
  not stored in the audit log; Pi already has it for accepted messages.

## Admission and busy conversations

- Each accepted message is submitted to its conversation with
  `requestId = "gw:" + channel + ":" + account + ":" + eventId`. Pi stores request ids per
  conversation and returns the existing submission for a repeat, so a redelivered event
  never submits twice, including after a restart.
- The gateway also records accepted event keys in `mars.gateway` (latest 2000) so a repeat
  is recognised before routing, for example after `/new` rebinds the chat. A repeat is
  audited as `duplicate` and acknowledged without a reply.
- An edited message (Telegram `edited_message`, Discord `MESSAGE_UPDATE`) is audited as
  `edited` and never submitted again: the original was already answered.
- Messages to a busy conversation use Pi's default `whenBusy: "followUp"`: they queue in
  that conversation's inbox and run after the current answer, in order. They never touch
  any other conversation. `/steer <text>` is explicit and uses `whenBusy: "steer"`.

## Commands

Commands start with `/` and are handled by the gateway, not the model. They bypass the
busy queue. In a Telegram group a command may name the bot (`/status@MarsBot`); the
adapter drops its own bot's name, and a command naming another bot gets no reply.

| Command | Effect |
| --- | --- |
| `/new [title]` | Create a new conversation and bind this chat to it. |
| `/sessions` | List the 10 most recent conversations with a number each. |
| `/switch <n or id>` | Bind this chat to that conversation (from `/sessions`, or any id). |
| `/status` | This chat's conversation: title, running or idle, queued messages, running workers. |
| `/stop` | Stop the running answer in this chat's conversation. |
| `/steer <text>` | Send text into the running answer instead of queueing it. |
| `/help` | List the commands. |

## Delivery

- When a submission settles, the gateway reads the answer entry and delivers its text to
  every route bound to that conversation, in order, and to the chat that sent the message
  even if that chat has since moved to another conversation with `/new` or `/switch`. The
  sending chat is stored with the watched submission (`origins`), so this holds across a
  restart. One answer reaches each chat once.
- Replies go through one chunker: split at paragraph, line, sentence, then space, then
  hard; never inside a code fence (a fence split across chunks is closed and reopened).
  Only the fence marker and a short language name are carried into the next chunk, never
  the rest of the opening line, and a marker longer than 10 characters is plain text, so
  every pass makes progress and the chunker always finishes. Only line breaks are dropped
  at a cut, so indented code keeps its indentation, and a hard cut never splits an emoji.
- Each chunk is a delivery job in `mars.gateway.outbox` with an id, so a restart resumes
  unsent chunks. Rate limits wait `retryAfterMs` and retry; a permanent error (403, chat
  not found) drops the job and records `delivery_failed` in the audit log. Delivery is at
  least once: a crash between send and record can repeat one chunk.
- While a conversation is answering, adapters that support it show a typing indicator.
  Edit-in-place streaming is not in v1.

## HTTP API adapter

Owner-authenticated, like every `/api` route:

- `POST /api/gateway/api/messages {chatId, eventId, text}` submits as channel `api`.
  Replies are collected in an outbox the caller reads with
  `GET /api/gateway/api/messages?chatId=...&after=<seq>`.
- `GET /api/gateway` returns adapters with health, bindings with conversation titles,
  pending pairings and the latest audit records.
- `POST /api/gateway/pairings {code, approve}` approves or rejects a pairing.
- `POST /api/gateway/bindings/delete {route}` unbinds a chat.
- `POST /api/gateway/allow/delete {channel, sender}` takes a sender off the approved list.
  It returns `{channel, sender, removed, configured}`; `configured: true` means the host
  configuration still allows that id. Removing twice is harmless.
- `GET /api/gateway` also returns `allowed` (the approved list per channel) and `owners`
  (the configured ids per channel).

## Telegram and Discord adapters

No new dependencies (research ADR): Telegram uses `fetch` long polling of `getUpdates`
(timeout 25 s, offset acknowledgement after the sink resolves); Discord uses Node's
built-in `WebSocket` for the Gateway (identify, heartbeat, resume) and `fetch` for REST.
Both read their tokens from Settings (`connections.json`) or the environment
(`MARS_TELEGRAM_TOKEN`, Discord's existing bot token). Owner sender ids come from
`MARS_TELEGRAM_OWNER` and `MARS_DISCORD_OWNER` or from pairing. Base URLs are injectable
so tests run against fake platform servers. An adapter without a token is listed as
`stopped` with "Add a token in Settings".

## Agent tools

- `gateway_status {}`: adapters, bindings and pending pairings, so the agent can answer
  "is Telegram connected?".

## What it does not do (v1)

- No edit-in-place streaming, attachments or voice from chat platforms.
- No per-user tool permissions: only the owner (and senders they approve) are allowed.
- No webhook mode for Telegram (the host binds loopback only).

## Acceptance

`packages/pi-host/check-gateway*.mjs`, on a real Pi harness with a scripted model and
fake platform servers:

1. Start a conversation from fake Telegram, see it in the conversation list with its
   channel, continue it through the web API, continue again from Telegram; every reply
   reaches the chat.
2. A redelivered event submits once, before and after a restart.
3. A message to a busy conversation queues and runs after; another conversation's run is
   untouched.
4. Bindings, pending pairings and unsent deliveries survive a restart.
5. Unknown sender gets a code, nothing reaches Pi; approval lets them in; every event is
   audited.
6. Fake platforms cover message, edit, duplicate delivery, rate limit (429), reconnect and
   permission denial (403).

### Running the acceptance flow on the real host

`check-gateway-e2e.mjs` boots the real `server.mjs` twice on one temporary data root, with
a fake Telegram and the staging-only echo model (`MARS_PI_STAGING=1 MARS_ECHO_MODEL=1`;
outside staging the echo model is never installed). It starts a conversation from
Telegram, continues it through `/api/chat` (the web UI's route), continues it from
Telegram, restarts the process and checks that the binding holds and a redelivered update
is not submitted or answered again.
