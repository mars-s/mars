# Live Pi client acceptance

The live route uses the existing, authenticated Pi Durable host as the only owner of conversation, model, extension and sign-in state. Browser storage contains appearance preferences only. Conversation selection and drafts stay in browser memory; conversation state is native SQLite. The supplied demonstration remains source reference and is not mounted.

The client polls `GET /api/state` without overlapping requests. Reconnection replaces the current snapshot, never resubmits prompts and never cancels server work. Durable entry IDs are React keys. Native tool calls and results remain disclosures, preserving their open state across snapshots. Partial generation is provisional and disappears when a committed entry arrives.

`POST /api/chat` carries text, selected conversationId and a unique request ID. Failed delivery keeps the request ID for an explicit retry of the same text. Stop calls `/api/abort`; switching views or closing the browser only detaches observation. Models come from the host catalogue, with selection confirmed by the next snapshot.

Settings contains ChatGPT sign-in, connection details and appearance as nested tabs. Sign-in callback URLs go directly to `/api/login-answer`, clear after submission and are never persisted in browser storage. Unsupported demo sessions, files, schedules, terminal and approvals do not appear as available capabilities.

Installed native extension modules mount in a labelled region, using their immutable catalogue hash. Browser rendering does not install extensions. The mocked Discord trial is explicit, uses `/api/trial`, and cannot send real Discord messages.

Acceptance: server snapshot survives reload; Markdown and code render through assistant-ui; composing Enter does not submit; ordinary Enter submits once; explicit stop reaches the host; disconnected state permits retry without inventing completion; mobile has no horizontal overflow; settings are keyboard accessible; reduced-motion preference suppresses decorative animation; an installed Mock Discord region survives host restart and supports its real local button.

New chat creates an ownerless native conversation. State, chat, model and abort resolve the selected ID; omitted ID keeps the historical root. List reads bounded native metadata, never every transcript. GET /api/conversations supports opaque cursor pagination. The sidebar currently shows the latest bounded page plus the original root. Native worker rows identify their owning parent; stopping validates that ownership. Worker summaries and usage are collapsed by default.
