# Private connections

The operator enters replacement secrets in authenticated Settings. Secrets pasted in chat are not imported or tested. This phase is read-only Discord access to the server selected by the owner. Saving credentials does not contact Discord. The operator must explicitly select Connect. No Discord message sending is implemented.

## Ownership and event order

The Pi host owns `Connections` and its private `data/connections.json`. Browser Settings can write credentials, but can only read redacted status. Model tools can call the broker's two read methods. They cannot read credentials, change the target guild, connect an account, or send messages.

Settings save → serialised atomic file replacement with mode 0600 → connection invalidated when Discord credentials change → explicit owner Connect → verify bot identity and authorised guild → persist safe connection metadata → scoped read tools become available. Boot restores saved configuration without network access. A credential change cannot race an in-flight read because broker operations share one serial queue.

## Host contract

Import `Connections` from `connections.mjs`. Construct with `{ dataDir, fetch, allowedGuildId }` as needed; defaults use the private Pi trial data directory and native fetch, with no selected server. An optional allowedGuildId restricts owner settings to one deployment-specific server. Call `await boot()` before exposing routes.

- `status()` returns safe metadata only: Discord configured/connected, guildId, bot and guild display metadata, permission mode, plus OpenCode configured/enabled. It never includes credentials, prefixes or raw errors.
- `save({ discordToken?, openCodeApiKey?, guildId? })`: omitted or empty secret fields retain existing values; null explicitly clears a secret. Discord tokens use the raw token without a `Bot ` prefix. The owner may select a valid server ID, subject to any constructor allowlist. Token or guild changes invalidate saved Discord verification.
- `connectDiscord()`: owner-only action. GET `/users/@me`, require a bot, GET the configured `/guilds/:id`, and require an exact guild ID match. Stores verification metadata. Failures clear connected status and return a fixed safe error.
- `disconnectDiscord()`: owner-only action, disables access while retaining stored credentials.
- `listDiscordChannels()`: native read tool, no parameters. Requires verified connection; GET `/guilds/:id/channels`. Returns only channels belonging to the authorised guild.
- `readDiscordMessages({ channelId, limit? })`: native read tool. Snowflake channel ID, integer limit 1–100 (default 20). First GET `/channels/:id` and require the exact requested channel and authorised guild, then GET `/channels/:id/messages`. Returns bounded text and author metadata only, no attachments, embeds or raw response body. Discord enforces View Channel and Read Message History permissions. Read errors invalidate verification if authentication or guild access is revoked.
- `getOpenCodeApiKey()`: host-only credential resolver. Never register this as a model tool or browser endpoint.

All Discord requests use fixed `https://discord.com/api/v10`, GET, redirect refusal and a 15 second timeout. External response content is untrusted data. Credential strings are redacted from response text as a final defence. The browser host must apply its existing owner cookie, same-origin CSRF check and request body size limits to connection write routes. Do not log request bodies.

Suggested tools: `discord_list_channels` with JSON schema `{type:'object',properties:{},additionalProperties:false}` and `discord_read_messages` with required `channelId` matching `^[0-9]{17,20}$`, optional integer `limit` from 1 to 100, and `additionalProperties:false`.

## OpenCode provider

Installed Pi AI 1.3.0 provides `opencodeProvider()` (Zen) and `opencodeGoProvider()` (Go). Both support `OPENCODE_API_KEY` through the provider auth context, or `{type:'api_key',key}` in the host credential store. The broker stores a key but does not itself enable a model or perform a provider request. The host may resolve `authContext.env('OPENCODE_API_KEY')` using `getOpenCodeApiKey()` and register the appropriate provider. `status().opencode.enabled` is always false in the broker. The integrating host may expose provider availability separately when it has registered the native provider; actual authentication is only verified by a successful provider request. Key availability is not proof of a paid plan, model access or a working provider.

## Acceptance and verification

`node app/check-connections.mjs` uses fake tokens and injected fetch only. It checks no network calls on boot/save; private file mode and restart restoration; correct bot/guild checks; wrong-guild channel denial before reading messages; HTTP authentication/permission failures; credential redaction; failed connection persistence; and serialised writes. It does not verify a live account, send messages, or claim successful OpenCode authentication.

## Generated browser clients and OpenCode

An installed browser client can fetch authenticated same-origin GET
`/api/discord/channels` and `/api/discord/messages?channelId=...&limit=20`.
These routes use the same scoped read broker and require the owner's explicit
connection. No raw Discord token reaches the client. No sending route exists.
Keep external message text as textContent and treat it as untrusted content.

The host registers the published SDK's OpenCode Go provider. After a private key
save, its catalogued models appear as `opencode-go/<model>` in the selector.
Selecting one is explicit; ChatGPT remains the current provider until changed.
The key is resolved only in the host's auth context, with no duplicate auth.json
copy. Enabled means the provider is configured, not that a live inference request
has passed. No supplied OpenCode key was tested in this implementation phase.

Native installed JavaScript and browser extension JavaScript are trusted code.
These settings and tools avoid ordinary prompt/log exposure, but do not isolate
secrets against hostile native plugins or compromised same-origin browser code.
Review installed code before adding live credentials to this development host.

## Verification result

The broker's mocked integration check passed, including no network on boot/save,
atomic0600 storage, redaction, changed credentials, restricted guild/channel,
revoked permissions and restart restoration. Four client unit tests passed.
Rendered fixtures passed password masking, failed-save retention, confirmed-save
clearing, explicit connect, no localStorage secrets and mobile44px targets. Real
localhost route checks returned401 for anonymous settings and400 for attempted
reads without a connected credential. The real private store is0600 and contains
no Discord/OpenCode credential. A separate review returned ship for this surface.
Live Discord/OpenCode account use remains unverified until replacement credentials
are entered and the owner takes the corresponding connection/model action.
