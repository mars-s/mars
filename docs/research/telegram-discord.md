# Telegram and Discord channel adapters: research notes

Researched 21 October 2026 against the live Telegram Bot API page (Bot API 10.3), the `discord/discord-api-docs` source that backs discord.com/developers/docs, the discord.js guide and the Node.js 24 docs. Lines marked **Unverified** are not in an official source and must be confirmed against the real service before code depends on them.

## Summary

Both adapters can be built with no new runtime dependency. Telegram is plain HTTPS JSON, so `fetch` long polling covers it. Discord needs one WebSocket for the Gateway plus REST calls. Node 24 ships a stable global `WebSocket`, and the host already talks to Discord REST with raw `fetch` in `packages/pi-host/connections.mjs`.

The hard parts are the same on both sides. Updates can arrive more than once, so dedupe on platform ids and store a cursor. Sends hit rate limits, so honour `retry_after` instead of fixed sleeps. Discord adds a session protocol (heartbeat, resume, re-identify) with a 1000 identify per day cap that resets the bot token when exceeded. That cap is the single biggest reason to test reconnect logic against a fake server before going live.

Local checks done for this note:

- `node_modules` has no `discord.js`, `grammy`, `telegraf` or Telegram package. `ws@8.22.0` is present only as a transitive dependency of `openai` and `@google/genai`, so the host must not import it.
- `connections.mjs` calls `https://discord.com/api/v10` with `Authorization: Bot <token>`, a `DiscordBot (url, version)` User-Agent, `redirect: "error"` and a 15 second `AbortSignal.timeout`. It clears verified state on 401, 403 and 404, and throws on 429 without reading `retry_after`. It scopes everything to one authorised guild.
- The repo pins Node `24.14.0`. The default `node` on this shell is v22.22.3. Both expose `typeof WebSocket === "function"`.

## Telegram

Base docs: [Bot API](https://core.telegram.org/bots/api), [Bot FAQ](https://core.telegram.org/bots/faq), [Bot features](https://core.telegram.org/bots/features).

### Receiving updates

- Long polling and webhooks are mutually exclusive. Telegram stores pending updates until the bot takes them, for at most 24 hours. [Getting updates](https://core.telegram.org/bots/api#getting-updates)
- `getUpdates` does not work while a webhook is set. Call `deleteWebhook` at startup if the bot might have had one. `drop_pending_updates` is optional and should stay off so queued owner messages survive a restart. [getUpdates](https://core.telegram.org/bots/api#getupdates), [deleteWebhook](https://core.telegram.org/bots/api#deletewebhook)
- `offset` must be one more than the highest `update_id` already received. An update counts as confirmed only when a later `getUpdates` call passes a higher offset. Without an offset, Telegram returns from the earliest unconfirmed update. [getUpdates](https://core.telegram.org/bots/api#getupdates), [FAQ](https://core.telegram.org/bots/faq#long-polling-gives-me-the-same-updates-again-and-again)
- So acknowledgement is implicit and lags by one request. If Mars crashes after handling update N but before the next poll, Telegram delivers N again. Persist the offset after each handled update and dedupe on `update_id`. The docs say to recalculate the offset after each response to avoid duplicates. [getUpdates notes](https://core.telegram.org/bots/api#getupdates)
- A negative offset returns updates from the end of the queue and forgets all earlier ones. Do not use it in normal operation. [getUpdates](https://core.telegram.org/bots/api#getupdates)
- `limit` accepts 1 to 100, default 100. `timeout` is in seconds, defaults to 0 (short polling), and should be positive in production. The `fetch` abort timer must be longer than `timeout`. [getUpdates](https://core.telegram.org/bots/api#getupdates)
- `allowed_updates` is sticky. If omitted, the previous setting applies. An empty list means every type except `chat_member`, `message_reaction` and `message_reaction_count`. Changing it does not filter updates created before the call. Pass `["message","edited_message","my_chat_member"]` explicitly on every call. [getUpdates](https://core.telegram.org/bots/api#getupdates)
- `update_id` values increase sequentially from a positive start. After a week with no updates, the next id is random. The adapter must not assume a gap means loss. [Update](https://core.telegram.org/bots/api#update)
- At most one optional field is set per `Update`. [Update](https://core.telegram.org/bots/api#update)
- `my_chat_member` arrives in private chats when the user blocks or unblocks the bot. Use it to pause outbound sends. [Update](https://core.telegram.org/bots/api#update)
- **Unverified.** Two concurrent `getUpdates` callers on one token are commonly reported to get HTTP 409 "Conflict". The API page does not document it. Treat any 409 as "another poller is running" and stop rather than fight.

### Webhooks versus polling

- Webhooks need a public HTTPS URL on port 443, 80, 88 or 8443 with a valid certificate. Redirects are not supported. [setWebhook](https://core.telegram.org/bots/api#setwebhook), [FAQ](https://core.telegram.org/bots/faq#im-having-problems-with-webhooks)
- Telegram retries a webhook on any non-2XX response "a reasonable amount of attempts", then gives up. `secret_token` (1 to 256 chars of `A-Za-z0-9_-`) comes back in `X-Telegram-Bot-Api-Secret-Token`. `max_connections` is 1 to 100, default 40. [setWebhook](https://core.telegram.org/bots/api#setwebhook)
- A webhook reply can carry a method call, but the bot cannot learn whether it succeeded. [Making requests when getting updates](https://core.telegram.org/bots/api#making-requests-when-getting-updates)
- For Mars, polling wins. The host is a personal machine, often behind NAT, and owner HTTP auth already guards inbound ports. Polling needs no public listener and gives an explicit, persistable cursor.

### Requests and errors

- Responses are JSON with `ok`. On failure, `description` and `error_code` are set, and `error_code` contents may change. Optional `parameters` is a `ResponseParameters`. [Making requests](https://core.telegram.org/bots/api#making-requests)
- `ResponseParameters.retry_after` is the number of seconds to wait after flood control. `migrate_to_chat_id` means a group became a supergroup with a new id. [ResponseParameters](https://core.telegram.org/bots/api#responseparameters)
- Send limits from the FAQ. Avoid more than one message per second in a single chat. Short bursts are allowed, then 429s follow. In a group, bots cannot send more than 20 messages per minute. Bulk sends top out at about 30 messages per second. [FAQ limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
- On 429, sleep exactly `parameters.retry_after` seconds, then retry the same request once the per-chat queue reaches it. Never retry in a tight loop.
- `sendMessage` has no idempotency key parameter. A retry after a timeout can post twice. [sendMessage](https://core.telegram.org/bots/api#sendmessage)
- **Unverified.** Status codes 400 "message is not modified", 403 "bot was blocked by the user" and 403 "bot is not a member" are widely reported but not documented. Match on `error_code` first and treat `description` as display text.

### Sending, streaming and typing

- `sendMessage.text` is 1 to 4096 characters after entity parsing. [sendMessage](https://core.telegram.org/bots/api#sendmessage)
- Entity offsets and lengths are in UTF-16 code units, which matches JavaScript `string.length`. [MessageEntity](https://core.telegram.org/bots/api#messageentity)
- `parse_mode` is `MarkdownV2`, `HTML` or legacy `Markdown`. MarkdownV2 requires escaping `_ * [ ] ( ) ~ \` > # + - = | { } . !` everywhere outside entities, so raw model output will often fail to parse. HTML needs only `<`, `>` and `&` escaped and supports a fixed tag list. Legacy Markdown cannot nest entities. [Formatting options](https://core.telegram.org/bots/api#formatting-options)
- Recommendation. Send plain text, or convert model Markdown to `entities` ourselves. If a formatted send fails to parse, resend as plain text. Split long replies on paragraph boundaries under 4096 UTF-16 units.
- `editMessageText` takes `chat_id` plus `message_id`, and the new text is again 1 to 4096 characters. Only messages without `reply_markup` or with inline keyboards can be edited. [editMessageText](https://core.telegram.org/bots/api#editmessagetext), [Updating messages](https://core.telegram.org/bots/api#updating-messages)
- No edit-specific rate limit is documented. Assume edits draw on the same per-chat budget as sends and throttle streaming edits to about one per second per chat, or slower in groups. This is an inference from the FAQ limits, not a published number.
- `sendMessageDraft` streams a partial message in private chats. The draft is a temporary 30 second preview, and the bot must call `sendMessage` with the final text to keep it. Text is 0 to 4096 characters, and empty text shows a "Thinking…" placeholder. `can_stop` adds a stop button that produces a `stopped_message_generation` update. [sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft)
- `sendMessageDraft` arrived in Bot API 9.3 and opened to all bots in 9.5. [API changelog](https://core.telegram.org/bots/api-changelog)
- `sendChatAction` with `action: "typing"` shows status for 5 seconds or less and clears when the bot's message arrives. Repeat it every 4 to 5 seconds while work continues. It accepts `message_thread_id`. Channels are not supported. [sendChatAction](https://core.telegram.org/bots/api#sendchataction)

### Chats, ids, topics and privacy

- `Chat.type` is `private`, `group`, `supergroup` or `channel`. [Chat](https://core.telegram.org/bots/api#chat)
- User and chat ids can exceed 32 bits but have at most 52 significant bits, so a JavaScript number is exact. Store them as strings anyway to share one id type with Discord. [User](https://core.telegram.org/bots/api#user), [Chat](https://core.telegram.org/bots/api#chat)
- `Message.message_thread_id` identifies a forum topic in supergroups and private chats. `is_topic_message` is true for topic messages. [Message](https://core.telegram.org/bots/api#message)
- `sendMessage.message_thread_id` targets a topic in forum supergroups and in private chats where the bot has forum topic mode on. `User.has_topics_enabled` from `getMe` reports that mode. [sendMessage](https://core.telegram.org/bots/api#sendmessage), [User](https://core.telegram.org/bots/api#user)
- A Mars session key should be `(chat.id, message_thread_id ?? 0)` so each topic maps to its own session.
- Privacy mode is on by default. In groups, a privacy-mode bot sees commands addressed to it, replies to its messages, and messages sent via it. Admin bots see everything. Turning privacy off requires removing and re-adding the bot to the group. [Privacy mode](https://core.telegram.org/bots/features#privacy-mode)
- Every bot receives all private chat messages and service messages regardless of privacy mode. Bots never see messages from other bots. [FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)
- Owner allow-listing must use `message.from.id`, not chat id, because groups contain other people.

## Discord

Base docs: [Gateway](https://discord.com/developers/docs/events/gateway), [Gateway events](https://discord.com/developers/docs/events/gateway-events), [Rate limits](https://discord.com/developers/docs/topics/rate-limits), [Opcodes and status codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes), [API reference](https://discord.com/developers/docs/reference).

### Gateway versus HTTP interactions

- Interactions (slash commands, buttons, modals) reach an app over the Gateway or over an HTTP Interactions Endpoint URL. The two are mutually exclusive, and Gateway is the default. [Interactions overview](https://discord.com/developers/docs/interactions/overview#preparing-for-interactions), [Receiving an interaction](https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction)
- HTTP interactions must get an initial response within 3 seconds. The token then lasts 15 minutes for follow-ups. [Interaction callback](https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-callback)
- Ordinary DMs and channel messages arrive only as the `MESSAGE_CREATE` Gateway event. HTTP interactions alone cannot read a normal chat, so a chat adapter needs the Gateway. [Message Create](https://discord.com/developers/docs/events/gateway-events#message-create)

### Intents

- Intents are a bitfield sent in Identify. Without an intent, the app gets none of its events. [Gateway intents](https://discord.com/developers/docs/events/gateway#gateway-intents)
- Needed bits. `GUILDS` is `1 << 0`. `GUILD_MESSAGES` is `1 << 9`. `DIRECT_MESSAGES` is `1 << 12`. `MESSAGE_CONTENT` is `1 << 15`. Together that is `37377`, or `4609` without message content. [List of intents](https://discord.com/developers/docs/events/gateway#list-of-intents)
- `MESSAGE_CONTENT` is privileged and must be enabled in the Developer Portal before Identify sends it. Apps under 10,000 users can self-enable. Sending a privileged intent that is not enabled closes the socket with 4014. Invalid bits close with 4013. [Privileged intents](https://discord.com/developers/docs/events/gateway#privileged-intents)
- Without `MESSAGE_CONTENT`, content fields are empty except in DMs with the app, messages that mention the app, and the app's own messages. [Message content intent](https://discord.com/developers/docs/events/gateway#message-content-intent)
- Recommendation. Start with `4609` and require an @mention in guild channels. Add `MESSAGE_CONTENT` only if the owner wants mention-free chat in a dedicated channel or thread.

### Connect, heartbeat, identify

- Fetch `GET /gateway/bot` once, cache `url`, and connect with `?v=10&encoding=json`. The response includes `session_start_limit` with `total`, `remaining`, `reset_after` in ms and `max_concurrency`. [Connecting](https://discord.com/developers/docs/events/gateway#connecting), [Get Gateway Bot](https://discord.com/developers/docs/events/gateway#get-gateway-bot)
- Hello (op 10) carries `heartbeat_interval` in ms, for example 45000. Wait `heartbeat_interval * random()` before the first Heartbeat (op 1), then send one every interval with `d` set to the last dispatch `s`, or `null`. [Sending heartbeats](https://discord.com/developers/docs/events/gateway#sending-heartbeats)
- Discord answers each heartbeat with op 11. If no ACK arrives before the next heartbeat is due, the connection is a zombie. Close with a code other than 1000 or 1001, then resume. If Discord sends op 1, heartbeat immediately. [Heartbeat interval](https://discord.com/developers/docs/events/gateway#heartbeat-interval)
- Identify (op 2) carries token, intents and `properties`. The Ready dispatch returns `session_id` and `resume_gateway_url`, and both must be stored. [Identifying](https://discord.com/developers/docs/events/gateway#identifying), [Ready event](https://discord.com/developers/docs/events/gateway#ready-event)
- Apps get 1000 Identify calls per 24 hours across all shards. Resumes do not count. Hitting the cap terminates all sessions **and resets the bot token**. [Identifying](https://discord.com/developers/docs/events/gateway#identifying)
- `max_concurrency` limits identifies per 5 seconds. Exceeding it returns Invalid Session (op 9). [Session start limit object](https://discord.com/developers/docs/events/gateway#session-start-limit-object)
- The client may send 120 Gateway events per connection per 60 seconds. Exceeding it disconnects immediately. The docs do not say whether heartbeats count, so budget for them. Each sent payload must be 4096 bytes or less or the socket closes with 4002. [Rate limiting](https://discord.com/developers/docs/events/gateway#rate-limiting), [Sending events](https://discord.com/developers/docs/events/gateway#sending-events)

### Disconnect, resume, reconnect

- Resume when you get Reconnect (op 7), a resumable close code, a close with no code, or op 9 with `d: true`. [Resuming](https://discord.com/developers/docs/events/gateway#resuming)
- To resume, open `resume_gateway_url` with the same query string and send op 6 with `token`, `session_id` and `seq`. Do not Identify. Discord replays missed events in order, then sends `RESUMED`. Skipping `resume_gateway_url` raises the disconnect rate. [Preparing to resume](https://discord.com/developers/docs/events/gateway#preparing-to-resume)
- Op 9 with `d: false` means the session is gone. Reconnect to the cached URL and Identify again. [Preparing to resume](https://discord.com/developers/docs/events/gateway#preparing-to-resume)
- Closing with 1000 or 1001 invalidates the session and shows the bot offline. Any other code keeps the session resumable for a few minutes. [Initiating a disconnect](https://discord.com/developers/docs/events/gateway#initiating-a-disconnect)
- Do not reconnect after 4004 (bad token), 4010, 4011, 4012, 4013 or 4014. 4007 and 4009 need a fresh session. The rest are reconnectable. [Gateway close event codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes)
- The WHATWG `close()` accepts only 1000 or 3000 to 4999, so the built-in client cannot send 1001 anyway. Use 4000 for zombie or restart closes so the session stays resumable. [WebSocket close()](https://websockets.spec.whatwg.org/#dom-websocket-close)
- Events can be sent zero, one or many times. Clients should handle them idempotently. Dedupe on message id. [Consistency](https://discord.com/developers/docs/reference#consistency)
- After a re-identify, events during the gap are lost. Backfill per watched channel with `GET /channels/{id}/messages?after=<last seen id>`, `limit` 1 to 100. It needs `READ_MESSAGE_HISTORY`, otherwise it returns nothing. [Get Channel Messages](https://discord.com/developers/docs/resources/message#get-channel-messages)

### REST, rate limits and errors

- Every HTTP request needs `User-Agent: DiscordBot ($url, $versionNumber)` or Cloudflare may block it. The current code already does this. [User agent](https://discord.com/developers/docs/reference#user-agent)
- Do not hard-code limits. Read `X-RateLimit-Remaining`, `X-RateLimit-Reset-After` (seconds, may be fractional) and `X-RateLimit-Bucket`, and key buckets by bucket plus top-level resource such as `channel_id`. [Rate limits](https://discord.com/developers/docs/topics/rate-limits), [Header format](https://discord.com/developers/docs/topics/rate-limits#header-format)
- A 429 body is `{ message, retry_after, global, code? }` with `retry_after` as a float in seconds. `Retry-After` and `X-RateLimit-Scope` (`user`, `global`, `shared`) come as headers. `X-RateLimit-Global: true` marks the global limit. [Exceeding a rate limit](https://discord.com/developers/docs/topics/rate-limits#exceeding-a-rate-limit)
- The global limit is 50 requests per second per bot. [Global rate limit](https://discord.com/developers/docs/topics/rate-limits#global-rate-limit)
- 10,000 invalid requests (401, 403, 429) per 10 minutes from one IP trigger a temporary Cloudflare ban. Shared-scope 429s do not count. After a 401, stop all requests until the owner replaces the token. [Invalid request limit](https://discord.com/developers/docs/topics/rate-limits#invalid-request-limit-aka-cloudflare-bans)
- JSON errors carry `{ code, message }`. Codes to handle are 50013 (missing permissions), 50001 (missing access), 50007 (cannot DM this user), 10003 (unknown channel) and 10008 (unknown message). [JSON error codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes)
- 403 with 50013 or 50001 is a permanent failure for that channel. Surface it to the owner and do not retry. The existing `#get` already treats 403 as a stop.

### Messages, edits, typing, threads, ids

- Create Message is `POST /channels/{id}/messages` with `content` up to 2000 characters. Guild channels need `SEND_MESSAGES`. [Create Message](https://discord.com/developers/docs/resources/message#create-message)
- `nonce` (up to 25 characters) with `enforce_nonce: true` makes a retry within "the past few minutes" return the earlier message instead of posting again. Use a deterministic nonce per outbound chunk. [Create Message](https://discord.com/developers/docs/resources/message#create-message)
- Set `allowed_mentions: { parse: [] }` on agent output so model text cannot ping `@everyone`. [Allowed mentions](https://discord.com/developers/docs/resources/message#allowed-mentions-object)
- Edit Message is `PATCH /channels/{id}/messages/{message_id}`, `content` again up to 2000. Only the author can change content. It fires `MESSAGE_UPDATE`, so the adapter must ignore updates to its own messages. [Edit Message](https://discord.com/developers/docs/resources/message#edit-message)
- Edits have no published fixed rate. Throttle streaming edits per channel from the bucket headers, with a floor of about one edit per second. That floor is our choice, not a Discord number.
- `POST /channels/{id}/typing` lasts 10 seconds and returns 204. Bots should use it only while computing a reply. Repeat about every 8 seconds. [Trigger Typing Indicator](https://discord.com/developers/docs/resources/channel#trigger-typing-indicator)
- Threads are channels. Messages in a thread come with `channel_id` set to the thread id, and replies go to that id. Talking in a thread needs `SEND_MESSAGES_IN_THREADS`, not `SEND_MESSAGES`. Private threads need an invite or `MANAGE_THREADS`. [Threads permissions](https://discord.com/developers/docs/topics/threads#permissions)
- Snowflakes are up to 64 bits and always strings in JSON. Keep them as strings. Compare with `BigInt` because they exceed `Number.MAX_SAFE_INTEGER`. The creation time is `(id >> 22) + 1420070400000` ms. [Snowflakes](https://discord.com/developers/docs/reference#snowflakes), [ID serialization](https://discord.com/developers/docs/reference#id-serialization)
- `MESSAGE_CREATE` includes `guild_id` for guild messages and omits it for DMs. Use `author.id` for the owner check, and ignore `author.bot`. [Message Create](https://discord.com/developers/docs/events/gateway-events#message-create)

### Raw client versus discord.js

- Node 24 has a global browser-compatible `WebSocket`, stable since v22.4.0. [Node globals: WebSocket](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-websocket)
- discord.js 14.27.0 unpacks to about 2.0 MB across 385 files and pulls 13 direct dependencies, including `undici`, `@discordjs/ws` and `@discordjs/rest`. `@discordjs/ws` in turn depends on `ws`. Figures from the npm registry ([discord.js](https://registry.npmjs.org/discord.js/latest), [@discordjs/ws](https://registry.npmjs.org/@discordjs/ws/latest)).
- discord.js also needs `Partials.Channel` to deliver DM events from uncached DM channels, which is extra surface to learn for one feature. [discord.js partials](https://discordjs.guide/legacy/popular-topics/partials)
- A single-shard, JSON, uncompressed client is about 200 to 300 lines. It needs Hello, jittered heartbeat with ACK tracking, Identify, Ready capture, dispatch with `s` tracking, op 7 and op 9 handling, the close-code table and resume. Discord's own page warns that custom clients must read the whole Gateway doc, which is fair. [Gateway](https://discord.com/developers/docs/events/gateway)
- Compression is optional. Leave it off for v1. [Encoding and compression](https://discord.com/developers/docs/events/gateway#encoding-and-compression)
- I think the raw client is the right call. Mars needs four intents, one guild, DMs and no caches. A library would bring a cache model and its own retry policy that we would have to wrap anyway to keep idempotent recovery and the existing guild scope.

## Fake server requirements

One local fake per platform, driven by tests, with injectable base URLs (`TELEGRAM_API_BASE`, `DISCORD_API_BASE`, gateway URL). Each item names the defect it catches.

### Telegram fake (HTTP only)

- [ ] `POST /bot<token>/getUpdates` honours `offset`, `limit` and `timeout`. It holds the request until an update is queued or the timeout ends, and returns `[]` on timeout.
- [ ] Confirmation semantics. Updates below the passed offset are dropped and others are returned again. A test restarts the adapter between handling and the next poll and asserts the update is processed once.
- [ ] Sticky `allowed_updates`. Record the last value and fail a test if a call omits it.
- [ ] `getUpdates` returns an error while a webhook is set, and `deleteWebhook` clears it.
- [ ] `sendMessage` rejects text over 4096 UTF-16 units and rejects a MarkdownV2 body with an unescaped `.`, so the plain-text fallback runs.
- [ ] `editMessageText` updates stored text and returns the message. A no-change edit returns 400 so the adapter skips identical edits (unverified wording).
- [ ] `sendMessageDraft` accepts private chat ids only, and the test asserts a final `sendMessage` follows.
- [ ] `sendChatAction` records calls, so a test can assert typing repeats under 5 seconds and stops after the reply.
- [ ] 429 injection with `{ok:false,error_code:429,parameters:{retry_after:N}}`. Assert no retry before N seconds on a fake clock and exactly one retry after.
- [ ] 403 injection for a blocked user plus a `my_chat_member` update with status `kicked`. Assert sends stop.
- [ ] `message_thread_id` echo, so topic routing maps to separate sessions.
- [ ] A group message from a non-owner `from.id`, which must be ignored.
- [ ] A 409 on a second concurrent poller, so the adapter stops instead of looping.

### Discord fake (REST plus WebSocket)

- [ ] `GET /gateway/bot` returns `url` and a `session_start_limit` whose `remaining` the fake decrements on every Identify.
- [ ] WebSocket sends Hello with a short `heartbeat_interval`, checks that each heartbeat `d` equals the last `s`, and ACKs with op 11.
- [ ] Zombie mode. The fake stops sending ACKs. Assert the client closes with a non-1000 code and resumes.
- [ ] Identify validation. Close 4014 for a privileged intent the fake marks disabled, and 4004 for a bad token. Assert no reconnect after either.
- [ ] Ready returns `session_id` and a distinct `resume_gateway_url`. Assert reconnects go to that URL with op 6, not op 2.
- [ ] Resume replays queued dispatches in order, then `RESUMED`. Op 9 `d:false` forces Identify on the cached URL.
- [ ] Op 7 mid-stream, and server close 4000. Both must resume.
- [ ] Duplicate `MESSAGE_CREATE` with the same id. Assert one agent turn.
- [ ] Gap backfill. After a forced re-identify, `GET /channels/{id}/messages?after=` returns the missed message once.
- [ ] Outbound sends over 120 per 60 s or payloads over 4096 bytes close the socket, so the client's own limiter is tested.
- [ ] `POST /channels/{id}/messages` rejects content over 2000, honours `nonce` with `enforce_nonce` by returning the first message, and records `allowed_mentions`.
- [ ] `PATCH .../messages/{id}` edits and emits `MESSAGE_UPDATE` for the bot's own message, which must be ignored.
- [ ] `POST /channels/{id}/typing` returns 204.
- [ ] 429 injection with a float `retry_after`, `X-RateLimit-Scope`, and a `global: true` variant that must pause all routes.
- [ ] 403 `{code:50013}` and `{code:50001}`. Assert no retry and an owner-visible error. 401 stops all REST calls.
- [ ] A thread `channel_id` and a DM without `guild_id`, both routed to the right session. A guild outside the authorised guild is ignored.

## Ranked decisions

| Decision | Adopt/Adapt/Reject | Evidence (link) |
| --- | --- | --- |
| Telegram receive with `getUpdates` long polling, persisted offset and `update_id` dedupe | Adopt | [getUpdates](https://core.telegram.org/bots/api#getupdates), [FAQ](https://core.telegram.org/bots/faq#long-polling-gives-me-the-same-updates-again-and-again) |
| Telegram webhooks | Reject for v1 | [setWebhook](https://core.telegram.org/bots/api#setwebhook) (public HTTPS on fixed ports) |
| Discord Gateway over built-in `WebSocket`, single shard, JSON, no compression | Adopt | [Gateway](https://discord.com/developers/docs/events/gateway), [Node WebSocket](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-websocket) |
| Depend on discord.js | Reject | [npm discord.js](https://registry.npmjs.org/discord.js/latest), [partials](https://discordjs.guide/legacy/popular-topics/partials) |
| Depend on grammY or Telegraf | Reject | [Bot API](https://core.telegram.org/bots/api#making-requests) is plain HTTPS JSON |
| Import transitive `ws` | Reject | Local `npm ls ws` shows it only under `openai` and `@google/genai` |
| Resume-first reconnect, with identify budget guard from `session_start_limit` | Adopt | [Identifying](https://discord.com/developers/docs/events/gateway#identifying), [Resuming](https://discord.com/developers/docs/events/gateway#resuming) |
| Honour `retry_after` on both platforms and Discord bucket headers | Adopt | [ResponseParameters](https://core.telegram.org/bots/api#responseparameters), [Discord rate limits](https://discord.com/developers/docs/topics/rate-limits) |
| Extend existing `#get` 429 handling to wait instead of throw | Adapt | [Exceeding a rate limit](https://discord.com/developers/docs/topics/rate-limits#exceeding-a-rate-limit) |
| Discord intents `4609`, mention-gated in guilds; add `MESSAGE_CONTENT` only on owner request | Adapt | [Message content intent](https://discord.com/developers/docs/events/gateway#message-content-intent) |
| Discord `nonce` with `enforce_nonce` for idempotent sends | Adopt | [Create Message](https://discord.com/developers/docs/resources/message#create-message) |
| Telegram streaming with `sendMessageDraft` in private chats, final `sendMessage` | Adopt | [sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft) |
| Streaming by throttled `editMessageText` / PATCH edits elsewhere, about 1 per second | Adapt | [FAQ limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this), [Discord headers](https://discord.com/developers/docs/topics/rate-limits#header-format) |
| Telegram plain text or self-built `entities`, never raw MarkdownV2 from the model | Adopt | [Formatting options](https://core.telegram.org/bots/api#formatting-options) |
| `allowed_mentions: { parse: [] }` on all Discord agent output | Adopt | [Allowed mentions](https://discord.com/developers/docs/resources/message#allowed-mentions-object) |
| Ids stored as strings on both platforms, `BigInt` compare for snowflakes | Adopt | [Snowflakes](https://discord.com/developers/docs/reference#snowflakes), [Chat](https://core.telegram.org/bots/api#chat) |
| Owner check on sender id (`from.id`, `author.id`), not chat id | Adopt | [Privacy mode](https://core.telegram.org/bots/features#privacy-mode), [Message Create](https://discord.com/developers/docs/events/gateway-events#message-create) |
| Discord HTTP Interactions Endpoint | Reject for v1 | [Interactions overview](https://discord.com/developers/docs/interactions/overview#preparing-for-interactions) (cannot carry normal messages) |
