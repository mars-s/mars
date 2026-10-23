# Connectors

Connectors are the one place in Mars to connect outside services so the agent can use
them, like the connectors in Claude and ChatGPT. The owner adds them in Settings,
Connectors, or the agent adds them with the `connector_` tools. Credentials stay on the
host; the browser and the agent only ever see whether one is saved.

## Model

A connector has a **kind**, a **transport** and an **auth method**.

| Kind | Reached by | The agent uses it through |
| --- | --- | --- |
| `mcp` | An MCP server over Streamable HTTP at a URL (JSON or SSE responses), or a local command over stdio | One Mars tool per server tool, `conn_<connector>_<tool>` |
| `http` | A plain HTTPS API at a base URL, for services without MCP | `connector_request({ connector, method, path, body })` with the stored credentials |

| Auth | What is stored | Sent as |
| --- | --- | --- |
| `none` | nothing | nothing |
| `key` | an API key or bearer token | HTTP: header `auth.header` (default `Authorization`) with `auth.prefix` (default `Bearer ` for `Authorization`, empty otherwise). Stdio: environment variable `auth.env` (default `MCP_API_KEY`) |
| `oauth` | access token, refresh token, client secret if any | `Authorization: Bearer <access token>` |

Each connector has an id (a slug of its name, `[a-z0-9-]`, up to 24 characters, unique)
and a status: `not_connected`, `connected`, `needs_auth` (the owner must sign in or
replace the key) or `error` (with `lastError`, at most 300 characters, secrets removed).

## Storage

- `data/connectors.json`: the connector list, without secrets. Name, kind, URL or
  command, auth method and its non-secret settings (header name, OAuth client id,
  discovered endpoints, issuer, scope), status, last error, and the cached tool list
  (Mars name, MCP name, description, input schema). Written atomically, mode 0600.
- `data/connector-secrets.json`: keys and tokens by connector id, through the same
  `Credentials` store as `auth.json` (security.mjs), mode 0600. `secrets.mjs` reads it,
  so `host_exec` output and saved artefacts redact these values like every other host
  secret.
- Nothing secret is returned by `/api/connectors`, the `connector_` tools or connector
  tool results. Connector output is also scrubbed of that connector's own secret values
  in case a server echoes them back.
- Pending OAuth sign-ins (state, PKCE verifier) live in memory for 10 minutes. A restart
  forgets them; the owner presses Connect again.

## MCP client

`mcp-client.mjs` is a small client written for Mars (no SDK):

- JSON-RPC 2.0. `initialize` with protocol version `2025-06-18`, then
  `notifications/initialized`. `tools/list` follows `nextCursor` (up to 20 pages, 500
  tools). `tools/call` runs a tool.
- Streamable HTTP: every message is a POST with `Accept: application/json,
  text/event-stream`. A JSON body or an SSE stream is accepted; in a stream, the first
  message with the request's id is the answer, notifications are skipped and server
  pings are answered. `Mcp-Session-Id` from `initialize` is sent on every later request
  and `MCP-Protocol-Version` after initialisation. A 404 on a session starts a new
  session once. Removing a connector sends `DELETE` to end its session.
- Stdio: newline-delimited JSON over the child's stdin and stdout. The command runs in
  the workspace folder with a minimal environment (`PATH`, `HOME`, `USER`, `LANG`,
  `TMPDIR`, plus the key variable when auth is `key`), never the host's own environment,
  so host secrets are not inherited. The last 2 KB of stderr explains a failure.
- Limits: 30 seconds for set-up requests, 120 seconds for a tool call, 4 MB for a
  response body or a stdio line. Tool results become text: text parts joined, structured
  content as JSON, images and audio as a short placeholder, resources as their text or
  URI, cut at 20000 characters with a note. `isError` results throw, so the model sees a
  failed call.

## Tools from MCP servers

Each connected MCP connector installs one plugin into the host plugin registry
(`plugin-registry.mjs`), named `connector-<id>`, kind `mcp`, titled with the connector
name. This is the same path installed extensions use, so the Extensions page and
`plugin_configure` switch a whole connector or a single tool on or off, and a switched-off
tool is not offered to the model. There is no second registry.

- Names: `conn_<id>_<tool>`, lowercased, every character outside `[a-z0-9_]` becomes
  `_`, at most 64 characters; a clash gets `_2`, `_3`.
- Every tool is deferred, so `tool_search` and codemode (`tools.conn_<id>_<tool>`, the
  `connectorTools` namespace) find it without adding every schema to every request.
- The description is the server's own, with a line naming the connector and a
  reminder that results are data from an outside service, plus an example call.
- The input schema is the server's own when it compiles and is under 32 KB; otherwise a
  plain object schema that accepts any arguments.
- Tool lists are cached in `connectors.json`, so tools come back after a restart without
  any network call. They refresh on connect and on `connector_refresh` (or Refresh in
  Settings). The server process or session starts on first use.

## OAuth 2.1

For `oauth` (and for an `mcp` connector with auth `none` whose server answers 401 with a
`WWW-Authenticate: Bearer` challenge, which switches it to `oauth`), Mars follows the MCP
authorization spec:

1. Probe the server. On 401 read `resource_metadata` and `scope` from
   `WWW-Authenticate`. Otherwise try `/.well-known/oauth-protected-resource<path>` and
   then `/.well-known/oauth-protected-resource` at the server's origin.
2. From the protected resource metadata take the first authorization server. Without
   metadata the server's origin is the authorization server.
3. Read authorization server metadata from
   `/.well-known/oauth-authorization-server<path>`, then
   `/.well-known/openid-configuration<path>`, then `<issuer>/.well-known/openid-configuration`.
   Metadata that lists `code_challenge_methods_supported` without `S256` is refused.
4. Client: the owner's `auth.clientId` (and optional client secret) if given; otherwise
   dynamic client registration at `registration_endpoint` (public client,
   `token_endpoint_auth_method: none` unless the server returns a secret). Without either,
   connecting fails and asks for a client id. A registration is redone when the redirect
   URI changes.
5. Authorisation URL with `response_type=code`, PKCE `S256`, a random 32-byte `state`,
   `resource` (RFC 8707, the server URL) and the scope. Mars returns this link; the owner
   opens it.
6. The authorization server redirects to `<origin>/api/connectors/oauth/callback`. The
   origin is `MARS_PUBLIC_ORIGIN` when set, otherwise the host the owner's request used
   (it already passed the host's origin policy), otherwise `http://127.0.0.1:<port>`.
   The callback is the one connectors route that does not need the owner cookie: the
   strict session cookie is not sent on a redirect from another site, so the unguessable,
   single-use, 10-minute `state` is what ties the redirect to the owner's sign-in. It
   checks `state`, checks `iss` when present, exchanges the code with the PKCE verifier,
   stores the tokens and connects. It answers with a small page telling the owner to
   return to Mars, and never shows a token.
7. Tokens are refreshed with the refresh token when less than 60 seconds remain, and once
   on a 401. A failed refresh sets `needs_auth`.

## Remote addresses

The agent already has full shell access, so the address rules guard against servers,
not against the owner:

- A connector URL must be `https://`, except loopback (`localhost`, `127.0.0.0/8`,
  `::1`), which may be `http://` for a server the owner runs on this machine. Mars's own
  ports are refused.
- Private and link-local networks (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`,
  `169.254/16`, `fc00::/7`, `fe80::/10`, `0.0.0.0`) are refused unless the connector is
  added with `allowPrivateNetwork: true`, the owner's deliberate choice for a server on
  the home network or tailnet. Host names are resolved and every address is checked, so a
  public name pointing at a private address is refused too. (The check runs before each
  connection; a name that changes its address between the check and the request is not
  caught.)
- URLs a server hands back (resource metadata, authorization server, token and
  registration endpoints) must be on the connector's own host name, or `https://` on a
  public address. A public server cannot steer Mars at loopback or the local network.
- Redirects are never followed; the error names the new location so the owner can fix
  the URL. URLs with a user name or password, and fragments, are refused.
- `connector_request` paths are relative to the base URL, may not leave its origin or
  path prefix, and may not set `Authorization`, `Cookie`, `Host` or the connector's own
  key header.

## Built-in connections

`/api/connectors` and `connector_list` also return read-only `builtIn` rows for what Mars
already connects elsewhere: Discord (Settings, Apps), the OpenCode key (Settings, Apps)
and GitHub through the Composio CLI (docs/GITHUB.md). They show status only and are
managed where they were before.

## HTTP API (owner authentication)

| Route | Does |
| --- | --- |
| `GET /api/connectors` | `{ connectors, builtIn, redirectUri }` |
| `POST /api/connectors` | Add `{ name, kind, url \| command, args?, auth?, key?, allowPrivateNetwork? }`; returns `{ connector }` |
| `POST /api/connectors/:id/connect` | Optional `{ key }`; returns `{ connector, authorizationUrl? }` |
| `POST /api/connectors/:id/refresh` | Reload the tool list |
| `POST /api/connectors/:id/remove`, `DELETE /api/connectors/:id` | Remove it, its tools, its secrets and its session |
| `GET /api/connectors/oauth/callback` | OAuth redirect target (no owner cookie, see above) |

## Agent tools

Namespace `connectors`, prefix `connector_`: `connector_list`, `connector_add`,
`connector_connect`, `connector_refresh`, `connector_remove` and `connector_request`.
A key can be passed to `connector_add` or `connector_connect` but is never returned.
OAuth always ends with the owner opening the link; the agent cannot sign in for them.

## Settings

Settings, Connectors lists built-in rows and the owner's connectors with kind, status,
tool count and last error, with Connect or Reconnect (opens the sign-in link in a new
tab), Refresh and Remove, and an Add connector form: name, MCP server URL, local command
or HTTP API URL, auth choice, key and header name. The key field is a password field
and is cleared after saving.

## Tests

`check-connectors.mjs` runs without network, all on loopback: a fake MCP server over
Streamable HTTP with SSE and sessions, a fake stdio MCP server
(`connector-fake-stdio.mjs`) and a fake OAuth authorization server with dynamic client
registration and PKCE (`connector-fakes.mjs`). It proves discovery and registration,
the code flow with state and PKCE checks, refresh, tool names and schemas, a tool call
round trip, plugin switches hiding tools, no secret in `/api/connectors` or tool output,
removal cleaning up, and the address rules, both in process and through a real host.
`apps/ui/tests/connectors-ui-check.mjs` checks the Settings tab against routed fixtures.
