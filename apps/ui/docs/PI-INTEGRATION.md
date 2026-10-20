# Pi integration

The live page mounts `components/live-workspace.tsx` and assistant-ui's external
store runtime. Pi Durable in `packages/pi-host` owns conversations, entries,
background tasks, selected models, usage and installed plugins. The browser owns
view selection, appearance preferences and unsubmitted drafts.

## Transport and ownership

`lib/pi/live-state.ts` validates the bounded host snapshot before the UI renders it.
`GET /api/state?conversationId=ID` returns one selected conversation, parent and
child metadata, independent workers, ordered workflows and image receipts.
Polling never fetches every transcript or image bytes. Reconnecting replaces the
snapshot and never resubmits an accepted prompt.

`POST /api/chat` submits text, an operation request ID, the selected conversation
and explicit attachment IDs. Identical retries retain the request ID. Browser
navigation and detachment do not cancel durable work. Stop is a separate
`POST /api/abort` action whose result remains associated with the original run.
Conversation creation and selection use `/api/conversations`; native metadata
owns titles and parent-child relationships. Workflow phases remain distinct from
independent child conversations.

Images upload as bounded PNG, JPEG, WebP or GIF bytes to `/api/attachments`.
The host normalises and stores private immutable files, supplies actual native
vision input, and persists only receipts in browser-visible snapshots. Children
receive images only by explicit reference. See [IMAGES-SUBTHREADS.md](IMAGES-SUBTHREADS.md).

Plugin cards load `/api/plugins` only when the catalogue is opened. Persisted
plugin, tool and interface switches control real native discovery and exposure.
Optional client modules use immutable `/extensions/HASH/client.js` paths and are
served only while the relevant interface is enabled. MCP wrappers share this
registry. Browser rendering never installs a plugin.

## Hosting and local development

The authenticated Pi host handles API routes and forwards page, asset and HMR
requests to Next. Both processes bind loopback by default. A configured private
proxy origin is explicit, with no wildcard host bypass. Credentials stay outside
Git and the browser bundle.

For a separate local UI checkout, `lib/server/pi-proxy.ts` forwards only supported
API routes and immutable extension modules. It requires server-only
`MARS_PI_ORIGIN` and `MARS_PI_TOKEN`, accepts local page origins only, rejects
cross-site writes, bounds JSON and image request bodies, and strips secret
upstream headers. See [Mac development](MAC-DEVELOPMENT.md) and the
[root setup](../../../README.md).

The original ZIP's `lib/pi/transport.ts`, browser-local store and demo components
remain unmounted reference source. Their simulated sessions and permission
selectors are not the native live API. See [ZIP-README.md](ZIP-README.md) for that
historical demonstration.

## Verification

Run the root typecheck, lint and unit scripts, then the UI fixture suite against
the running Next server. The fixtures cover account settings, conversation
switching and retry, image paste/removal and references, subthreads, workflows,
plugin persistence and activity rendering. They do not access live accounts or
send model requests. The opt-in existing-host check separately tests owner auth
and the already configured Mock Discord fixture.
