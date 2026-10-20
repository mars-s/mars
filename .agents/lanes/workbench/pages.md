# Lane: pages (and side chat)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/wb-pages`, branch `codex/wb-pages`, UI port **3233**.
Contract: docs/WORKBENCH.md "Pages". Host module `packages/pi-host/workbench/pages.mjs`
(must export `list()` used by suggestions), check `check-workbench-pages.mjs`.
Panes `apps/ui/components/workbench/page-pane.tsx` and `side-chat-pane.tsx` (+ css),
browser check `apps/ui/tests/workbench-pages-check.mjs`. You also own the `side-chat`
case in panes.tsx (add it beside your `page` case).

Pages: list of pages, "New page" creates one with a generated name, a Markdown editor
(textarea, 15px mono-free sans) with a live preview toggle, autosave debounced 800 ms
with "Saved" state, 409 conflict shown as "Changed elsewhere: reload or overwrite"
(overwrite only on explicit click). Title is the first `# heading` or the name.
Host: names `[a-z0-9-]{1,64}`, 1 MiB cap, writes atomic (temp file + rename),
`baseModified` conflict check.

Side chat: a second Pi conversation inside the pane. Pick an existing conversation or
create one with POST `/api/conversations`; show its messages read from
`/api/state?conversationId=<id>` (poll 1.5 s while the pane is visible) with the same
Markdown and tool activity renderers (`components/thread/messages.tsx` parts may need
small exports; prefer composing assistant-ui `AssistantRuntimeProvider` with its own
`useExternalStoreRuntime` like `live-workspace.tsx` `ConversationRuntime` does), and a
compact composer that sends to `/api/chat` with `conversationId` and a `requestId`.
It must never change the main chat's selection, draft or scroll. Stop works for the
side conversation only (`/api/abort` with its conversationId). If you need small
exports from files you do not own, request them as diffs.
