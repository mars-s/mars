# Mars workbench

The workbench is a second pane beside the conversation, like the ChatGPT desktop
app's side panel. A `+` button at the top right of the conversation header
("Open workbench") splits the main area. The pane holds tabs. A new tab is a
launcher with **Tools** and **Suggested**; every tile opens a real pane backed by
the Pi host or is shown disabled with the reason.

This document is the contract. Write it before code; change it in the same commit
as any behaviour change.

## Product model

| Term | Meaning |
| --- | --- |
| Workbench | The right-hand pane. Open or closed, a width, and an expanded flag. |
| Tab | One view in the workbench: a launcher or a tool pane. Tabs have a stable id. |
| Tool | A kind of pane: `launcher`, `changes`, `files`, `terminal`, `side-chat`, `page`, `browser`, `extension`. |
| Target | What a tool pane shows: a file path, a page name, a URL, an extension hash, a conversation id, a terminal session id. |
| Suggestion | A live thing the host detected: a listening local HTTP service, an installed extension UI, a recent page. |

```ts
type ToolKind = "launcher" | "changes" | "files" | "terminal" | "side-chat" | "page" | "browser" | "extension";
type WorkbenchTab =
  | { id: string; kind: "launcher" }
  | { id: string; kind: "changes"; repo?: string }
  | { id: string; kind: "files"; path?: string }
  | { id: string; kind: "terminal"; sessionId?: string }
  | { id: string; kind: "side-chat"; conversationId?: string }
  | { id: string; kind: "page"; name?: string }
  | { id: string; kind: "browser"; url?: string }
  | { id: string; kind: "extension"; hash: string; title: string };
type WorkbenchState = {
  open: boolean;
  expanded: boolean;
  width: number; // pixels, clamped to [360, main area - 480]
  tabs: WorkbenchTab[]; // at least one when open
  activeId: string;
};
```

State is a reducer in `apps/ui/components/workbench/workbench-state.ts`, persisted
per browser in localStorage (`mars-workbench-v1`) without secrets or content: only
kinds, targets and ids. Opening or closing the workbench never remounts the chat,
so the draft, scroll position and selected conversation survive. Only the main chat
runtime is keyed by the selected conversation; the workbench provider sits outside
it, so switching chats keeps every workbench tab, including side chat. Terminal
sessions live on the host and survive a closed tab until their idle timeout.

`WorkbenchProvider` also accepts `initial` and `persist={false}`. That embedded mode
(used by the `/design-system` specimens) never reads or writes stored layout, binds no
global shortcuts and never becomes the phone sheet.

## Layout

- Desktop: `main` becomes a two-column grid, chat then a 6px divider then the
  workbench. The divider is a `role="separator"` with `aria-orientation="vertical"`,
  `aria-valuenow` in pixels, dragged with the pointer or moved with Left and Right
  (Shift for 64px steps), Home and End. `aria-valuenow` reports the rendered width
  and `aria-valuemax` the space available. The pane keeps a 360px floor
  (`max(360px, 100% - 480px)`), so at 1024px with the sidebar open the chat gives
  way rather than the pane dropping below its minimum.
- Expanded: the workbench takes the main area and the chat collapses to a narrow
  restore strip. Toggle with the header button or Cmd/Ctrl+Shift+E.
- 768px and narrower: the workbench is a full-screen sheet over the chat with a
  Back button. Focus moves into the sheet, the chat behind it is `inert`, Escape or
  Back closes it and focus returns to the toggle. No horizontal overflow at 390px.
- Tool shortcuts (Ctrl, as shown on the tiles) open a tool only when the host
  reports it available; otherwise they open a New tab, where the reason is shown.
- Header: tab strip (icon, title, close), a `+` new-tab button, expand and close.

## Host contract

All routes sit under `/api/workbench/`. They reuse the host's existing owner
authentication (cookie or bearer), host check and exact-origin check for writes.
Every route answers JSON unless stated. Errors use the existing `{ error }` shape.

### Roots and paths

The workbench sees one root: the Pi workspace `WORK` (`$MARS_PI_ROOT/workspace`).
`resolveInside(root, relative)` rejects absolute paths, `..` segments, NUL bytes and
any path whose `realpath` (or nearest existing ancestor's realpath) leaves the root,
so symlinks cannot escape. File reads are capped at 2 MiB; listings at 2,000 entries.

### Capabilities

`GET /api/workbench/capabilities` returns which tools work on this host and why
not, for example `{ terminal: { available: false, reason: "python3 was not found" } }`.
The launcher renders exactly this; nothing is assumed by the browser.

### Files

- `GET /api/workbench/files?path=<rel>`: a directory listing `{ path, truncated, entries: [{ name, type: "file"|"dir"|"link", size, modified, hidden, target? }] }`,
  folders first, hiding nothing but marking dotfiles (`hidden`). A link carries
  `target: { type: "dir"|"file", path }` when it resolves inside `WORK`, otherwise
  `{ type: "outside"|"missing" }`, and is never followed out. `node_modules` and
  `.git` are listed but not descended by search.
- `GET /api/workbench/file?path=<rel>`: `{ path, size, modified, kind: "text"|"image"|"binary", text?, truncated?, mime? }`.
  The kind comes from the first 8 KiB: PNG, JPEG, GIF or WebP magic bytes make an
  image (`mime`), NUL bytes or invalid UTF-8 make binary, anything else is text
  capped at 2 MiB with `truncated`. The extension is never consulted; SVG is text.
  Only regular files open, without following a final symlink or blocking on a FIFO.
- `GET /api/workbench/raw?path=<rel>`: streams an image with its sniffed type,
  `nosniff` and a sandbox CSP, at most 20 MiB. Anything that is not an image is 415.
- `GET /api/workbench/search?q=<text>`: quick open by file or folder name,
  breadth first, not following links, max 200 results and 3 s:
  `{ query, results: [{ path, type }], truncated, timedOut }`, exact then prefix then
  substring matches. Read-only. No write routes for files in this version.

### Changes

- `GET /api/workbench/repos`: git repositories at or under `WORK` (depth 3), each
  `{ path, branch, ahead, behind, dirty }`.
- `GET /api/workbench/changes?repo=<rel>`: `{ repo, branch, files: [{ path, status, added, removed, binary }], patch }`
  from `git status --porcelain=v2` and `git diff --no-color HEAD` (untracked text
  files included as additions), patch capped at 1 MiB with a `truncated` flag.
  Git runs with `GIT_OPTIONAL_LOCKS=0`, no pager, no config-driven external diff or
  hooks, and a 10 s timeout. Read-only.
  `status` is one letter: `M`, `A`, `D`, `T`, `U` from `git diff --raw` (renames off)
  or `?` for untracked. `added`/`removed` come from `--numstat` and stay exact when the
  patch is cut; binary files have `binary: true` and zero counts. Untracked files use
  `git diff --no-index /dev/null <file>`, at most 50 (more sets `truncated`). A repo
  with no commits diffs against the empty tree. `fsmonitor`, textconv and
  repository-configured clean/smudge/process filters are switched off, so opening a
  repo never runs its config. A repo is a directory whose `.git` is a real directory.
  `/repos` skips `node_modules` and `.git` and does not follow symlinks.
  `capabilities.changes` is unavailable with "git was not found on the host." when
  git is missing.

### Pages

- `GET /api/workbench/pages`: `{ pages: [{ name, title, modified, size }] }` from
  `WORK/pages/*.md`, newest first.
- `GET /api/workbench/pages/<name>`: `{ name, text, modified }`.
- `POST /api/workbench/pages`: `{ name?, text, baseModified? }` creates or saves.
  Names are `[a-z0-9-]{1,64}`; a stale `baseModified` returns 409 so an edit never
  silently overwrites a newer save. Text capped at 1 MiB.

### Terminal

A session is a host child process: `python3 pty-bridge.py <shell> -l` in `WORK`,
one per tab, at most 4 per host, idle timeout 30 minutes, output ring buffer 256 KiB.

- `POST /api/workbench/terminal`: `{ cols, rows }` creates `{ id }`.
- `GET /api/workbench/terminal/<id>?since=<offset>`: long poll. Returns at once if
  output after `since` exists, otherwise waits up to 20 s:
  `{ offset, data (base64), exited?, exitCode? }`. A `since` older than the buffer
  returns the oldest retained output with `dropped: true`. Long polling works
  through the Next development proxy (25 s timeout) and Tailscale alike.
- `POST /api/workbench/terminal/<id>/input`: `{ data (base64) }`, max 64 KiB.
- `POST /api/workbench/terminal/<id>/resize`: `{ cols, rows }`, clamped 20..400 by 5..200.
- `POST /api/workbench/terminal/<id>/kill`: ends the process group.
- `GET /api/workbench/terminals`: live sessions `{ id, created, lastActive, exited }`.

Why not node-pty and a WebSocket, as first planned: node-pty 1.1.0 failed
`posix_spawnp` on the owner's Mac and ships no Linux prebuild, and the Next
development proxy does not forward WebSocket upgrades. A standard-library Python
bridge plus HTTP long polling works on macOS, Debian and through every proxy in use.
The shell gets a minimal environment (PATH, HOME, LANG, TERM, SHELL, USER), never the
owner token. Ending a session sends SIGHUP to every process group on its TTY, then
SIGKILL after 1 s, so background jobs that ignore hang-ups also end.

Input bytes are never logged. Closing a tab detaches; killing is the explicit
"End session" action in the pane menu. The shell runs as the host user, the same
authority the agent's own `host_exec` tool already has.

### Services and browser

- `GET /api/workbench/services`: TCP listeners on loopback or wildcard addresses found
  by `lsof` (macOS) or `ss` (Linux), excluding the host port, the UI port and
  `MARS_WORKBENCH_EXCLUDE_PORTS`, each probed with HTTP GET `/` (1.5 s) and kept only
  if it answers HTTP: `{ port, title?, status }`. Cached 10 s. A listener that did not
  answer HTTP is not probed again for 5 minutes. `MARS_WORKBENCH_PORTS` adds ports
  lsof or ss cannot see.
- `POST /api/workbench/browse-key {port}` (owner, exact origin): mints a browse key for
  one discovered, non-excluded port, `201 {key}`, else 403. 32 random bytes in
  base64url, held in memory only and never logged. A key expires after 15 minutes idle
  or 8 hours, at most 32 live keys (oldest evicted). It is bound to the process
  listening on the port when it was minted: if that process exits and another takes
  the port, the key stops working. `POST
  /api/workbench/browse-key/revoke {key}`; the pane revokes its keys when the tab closes.
- `GET|POST /api/workbench/browse/<port>/~<key>/<path>`: the keyed proxy. It is
  checked before owner authentication, because a sandboxed page's own requests are
  cross-site and carry no `SameSite=Strict` cookie. It grants only proxying to the
  key's own port: a key for another port, or an unknown, expired or revoked key, falls
  through to owner auth and gets 401, and a key opens no other route. Encoded dot
  segments are resolved before routing, so they leave the keyed path. The unkeyed form
  `/api/workbench/browse/<port>/<path>` needs the owner.
- Both forms reach `127.0.0.1` or `::1` on that port only. Requests drop `cookie`,
  `authorization`, `origin`, `referer` and `x-forwarded-*`. Response headers are
  forwarded from an allow list (content type, length, caching, location and similar),
  never `set-cookie`, CSP, framing, HSTS, CORS, `refresh` or reporting headers. Every
  response gets `x-content-type-options: nosniff` and
  `content-security-policy: sandbox allow-scripts allow-forms allow-popups;
  frame-ancestors 'self'`, `referrer-policy: no-referrer` and, for keyed requests
  only, `access-control-allow-origin: null` so the opaque frame can read its own
  service's module scripts and fetches. That is safe because keyed requests carry no
  credentials. Same-service redirects are rewritten into the proxy. Redirects to
  another port or host become a 502 JSON error. Bodies are capped at 20 MiB both ways.
- A hostile service cannot take the host down: upstream statuses outside 200 to 599
  (and 304) become 502, every upstream callback is guarded, rewriting uses linear
  scans (no backtracking regexes on tags), only HTML, CSS and JS up to 2 MiB are
  buffered for rewriting (larger text streams through as is, larger HTML is refused),
  a body that goes quiet for 30 s is cut off, discovery probes have a hard 1.6 s
  deadline, and at most 24 proxied requests run at once (12 per port), beyond which
  the answer is 503.
- Root-relative URLs: `<base>` alone does not fix `/assets/app.js` or
  `fetch("/api")`. The proxy injects `<base>` plus a small script first in `<head>`.
  The script routes root-relative `fetch`, `XMLHttpRequest`, `EventSource` and
  `history.pushState/replaceState` into the keyed prefix and reports in-frame
  navigation to the pane with `postMessage`. The proxy also rewrites root-relative
  `src`, `href`, `action`, `srcset`, `poster`, CSS `url()` and `@import`, and JS module
  specifiers in HTML, CSS and JavaScript responses.
- Known limits, stated honestly: WebSockets and absolute URLs to the service's own
  origin (`http://localhost:5173/...` built at runtime) are not rewritten. Service
  workers and storage are unavailable in the opaque origin. Compressed HTML is passed
  through without rewriting. Hot reload in proxied dev servers therefore may not work.
- The pane: address bar, Back, Forward and Reload from its own history stack, the
  iframe with `sandbox="allow-scripts allow-forms allow-popups"` (never
  `allow-same-origin`) and `referrerpolicy="no-referrer"`, and loading and error
  states. Messages from the frame are accepted only from that frame's window and only
  for paths under the tab's own port prefix. An external URL is never proxied; the
  pane offers "Open in a new tab" (`noopener noreferrer`). The tab keeps its URL.
- Development: the Next dev proxy forwards the keyed form without the owner token,
  exempt only from its same-site and JSON checks, with the same sandbox headers.
  `skipTrailingSlashRedirect` keeps the trailing `/` the `<base>` needs. In production
  the Next proxy is off and the Pi host serves `/api` directly.

### Suggested

`GET /api/workbench/suggestions` combines services, extension UIs from the
existing catalogue and the five most recent pages, each `{ kind, title, target }`.
Only things that exist right now appear.

### Extensions

"More tools" lists installed, enabled extensions with a UI from `snapshot.extensions`.
Each opens in its own tab through the exact `ExtensionPanel` mount used by the
Extensions page (`/extensions/<hash>/client.js`). A tab whose extension was since
disabled or removed says so instead of loading.

## Side chats belong to their parent

A side chat is an ordinary ownerless Pi conversation plus two native documents,
written in the one commit that creates it: `mars.side-chat` (`{ parentId }`) on the
child and `mars.side-chat-index` (`{ children }`, newest last) on the parent. The parent
is checked inside that commit, so a crash or a race can never leave a half-linked or
doubly nested side chat. Forks start with neither document. At most 200 side chats
per parent. Pi stays the only store: the link lives in Pi, so the UI, the HTTP API and the
agent all see the same thing.

- `POST /api/conversations { title?, provider?, modelId?, parentId? }`: with `parentId`
  (which must exist and must not itself be a side chat or a worker), creates the
  conversation and writes the link in the same request. Answers
  `{ conversation: { id, title, parentId } }`.
- `GET /api/conversations` and `GET /api/state` `conversations`: top-level rows only.
  Each row has `sideChats: [{ id, title, running }]`, the newest 20 read from the
  parent's index (no scan), plus `sideChatTotal` when there are more. A side chat never
  appears as its own Recents row. Listing is read-only.
- `GET /api/state` for a side chat includes `parentConversationId` and `sideChatOf`, so
  the sidebar keeps it nested under its parent while open.
- Sidebar: side chats sit indented under their parent with a small side-chat glyph,
  like subthreads, and open in the main view on click.

Agent tools (deferred, discovered on demand like the worker tools):

- `side_chat_open { title?, task? }`: opens a side chat of the calling conversation,
  optionally sends `task` as its first message, and returns `{ id, title }`. It does not
  wait for an answer.
- `side_chat_list { offset? }`: the calling conversation's side chats,
  `{ items: [{ id, title, running }], total }`, newest first, 20 per page.
- `side_chat_send { sideChatId, text }`: sends text to one of the caller's own side
  chats and returns at once. A side chat that is not the caller's is refused.

## File downloads

- `GET /api/workbench/download?path=<rel>`: any regular file inside `WORK`, at most
  20 MiB, opened with the same confinement as reads (`openInside`: no `..`, no symlink
  escape, handle checked after open). The response is
  `content-type: application/octet-stream`, `content-disposition: attachment;
  filename*=UTF-8''<name>`, `x-content-type-options: nosniff` and
  `content-security-policy: sandbox`, so nothing in it can run in the Mars origin.
  Folders, FIFOs and devices are refused.
- Files pane: a Download button in the viewer header for every file, and a labelled
  one in the binary-file view.
- Hard-linked files (`nlink > 1`) are refused: a hard link inside WORK can name a file
  that also lives outside it, which no path check can see. `filename*` follows RFC 5987.
- Agent tool `workspace_file_link { path }` (deferred): checks the path the same way
  and returns `{ path, size, url }` with the relative download URL, so the agent can
  hand the owner a working download link in chat. It never returns file contents, and
  its errors are plain reasons without host paths.

## UI files

`apps/ui/components/workbench/`: `workbench.tsx` (shell, divider, tabs),
`workbench-state.ts` (reducer and persistence), `launcher.tsx`, and one file per
pane: `changes-pane.tsx`, `files-pane.tsx`, `terminal-pane.tsx`, `side-chat-pane.tsx`,
`page-pane.tsx`, `browser-pane.tsx`, `extension-pane.tsx`. `lib/pi/workbench.ts`
parses every host response at the boundary.

## Verification

Host: one check per route group in `packages/pi-host/check-workbench-*.mjs` using a
temporary `MARS_PI_ROOT`: auth required, path escape and symlink escape rejected,
stale page save rejected, terminal create/output/resize/kill/idle, service probe and
proxy target refusal, header stripping. UI: unit tests for the reducer and parsers;
browser fixtures for open/close/resize/keyboard, each pane, mobile 390px overflow.
The preview fixture serves labelled fixture data for every route.
`/design-system` renders each real pane on in-page sample data
(`app/design-system/sample-host.ts`), which answers workbench routes in the page
and never reaches Pi.
