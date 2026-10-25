# Live Pi client acceptance

The live route uses the existing, authenticated Pi Durable host as the only owner of conversation, model, extension and sign-in state. Browser storage contains appearance preferences only. Conversation selection and drafts stay in browser memory; conversation state is native SQLite. The supplied demonstration remains source reference and is not mounted.

The client polls `GET /api/state` without overlapping requests. Reconnection replaces the current snapshot, never resubmits prompts and never cancels server work. Durable entry IDs are React keys. Native tool calls and results remain disclosures, preserving their open state across snapshots. Partial generation is provisional and disappears when a committed entry arrives.

`POST /api/chat` carries text, selected conversationId and a unique request ID. Failed delivery keeps the request ID for an explicit retry of the same text. A send that fails after the owner switched chats goes back into that chat's draft (or its composer, if it is open again), with an error naming the chat. A `?conversation=` id the host reports as not found opens the main conversation with a note, instead of retrying the missing id. A rename, pin or archive drops any `/api/state` poll already in flight, and a failed one reloads the host's rows rather than restoring the list from before it. Stop calls `/api/abort`; switching views or closing the browser only detaches observation. Models come from the host catalogue, with selection confirmed by the next snapshot.

Settings contains ChatGPT sign-in, connection details and appearance as nested tabs. Sign-in callback URLs go directly to `/api/login-answer`, clear after submission and are never persisted in browser storage. Unsupported demo sessions, files, schedules, terminal and approvals do not appear as available capabilities.

Installed native extension modules mount in a labelled region, using their immutable catalogue hash. Browser rendering does not install extensions. The mocked Discord trial is explicit, uses `/api/trial`, and cannot send real Discord messages.

Acceptance: server snapshot survives reload; Markdown and code render through assistant-ui; composing Enter does not submit; ordinary Enter submits once; explicit stop reaches the host; disconnected state permits retry without inventing completion; mobile has no horizontal overflow; settings are keyboard accessible; reduced-motion preference suppresses decorative animation; an installed Mock Discord region survives host restart and supports its real local button.

New chat creates an ownerless native conversation. State, chat, model and abort resolve the selected ID; omitted ID keeps the historical root. List reads bounded native metadata, never every transcript. GET /api/conversations supports opaque cursor pagination. The sidebar currently shows the latest bounded page plus the original root and every pinned chat, however old; finding older pinned chats reads one small filing document per older chat, never a transcript. Grouped and archived chats past the first page are not added, because scheduled runs file every chat they start in a group. Native worker rows identify their owning parent; stopping validates that ownership. Worker summaries and usage are collapsed by default.

## State caching

Switching chats should feel instant, so `/api/state` and the page both cache.

- **Host** (`packages/pi-host/state-cache.mjs`): a chat's transcript is the heavy part of
  `/api/state` (a long chat is megabytes of entries). Its browser-safe JSON is kept per
  conversation (the 24 most recent) and rebuilt only when an entry is added or the last one
  changes; the small docs are copied fresh every time. The answer carries an ETag: a poll with
  `If-None-Match` that finds nothing new gets `304` and no body. Answers over 32 KB are gzipped
  for clients that accept it. Check: `check-state-cache.mjs`.
- **Page** (`apps/ui/lib/pi/state-cache.ts`): the last parsed state of the 12 most recent chats
  stays in memory, so opening one shows it at once while the fresh copy loads; polls send its
  ETag, so an unchanged chat costs no parsing. The raw state of the 6 most recent chats is also
  saved in IndexedDB (at most every 10 seconds per chat), so a reload shows the chat as it was
  before the host answers. "Connecting to Pi…" shows only when loading takes over 1.5 seconds.
  Checks: `tests/state-cache.test.mjs`, `tests/state-cache-ui-check.mjs`.
