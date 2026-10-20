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
  width: number; // pixels, clamped to [360, viewport - 420]
  tabs: WorkbenchTab[]; // at least one when open
  activeId: string;
};
```

State is a reducer in `apps/ui/components/workbench/workbench-state.ts`, persisted
per browser in localStorage (`mars-workbench-v1`) without secrets or content: only
kinds, targets and ids. Opening or closing the workbench never remounts the chat,
so the draft, scroll position and selected conversation survive. Terminal sessions
live on the host and survive a closed tab until their idle timeout.

## Layout

- Desktop: `main` becomes a two-column grid, chat then a 6px divider then the
  workbench. The divider is a `role="separator"` with `aria-orientation="vertical"`,
  `aria-valuenow` in pixels, dragged with the pointer or moved with Left and Right
  (Shift for 64px steps), Home and End. Default width 46% of the main area.
- Expanded: the workbench takes the main area and the chat collapses to a narrow
  restore strip. Toggle with the header button or Cmd/Ctrl+Shift+E.
- 768px and narrower: the workbench is a full-screen sheet over the chat with a
  Back button. No horizontal overflow at 390px.
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

Input bytes are never logged. Closing a tab detaches; killing is the explicit
"End session" action in the pane menu. The shell runs as the host user, the same
authority the agent's own `host_exec` tool already has.

### Services and browser

- `GET /api/workbench/services`: TCP listeners on loopback found by `lsof` (macOS)
  or `ss` (Linux), excluding the host and UI ports themselves, each probed with an
  HTTP GET `/` (1.5 s timeout) and kept only if it answers HTTP: `{ port, title?, status }`.
  Results are cached 10 s.
- `GET|POST /api/workbench/browse/<port>/<path>`: reverse proxy to
  `http://127.0.0.1:<port>/<path>` only when `<port>` is in the current services
  list (or `MARS_WORKBENCH_PORTS`). Never another host. Requests drop `cookie`,
  `authorization`, `origin` and `referer`; responses drop `set-cookie`,
  `content-security-policy`, `x-frame-options` and `strict-transport-security`,
  and get `content-security-policy: sandbox allow-scripts allow-forms allow-popups`
  so a proxied page runs in an opaque origin and cannot call Mars APIs with the
  owner cookie. Redirects to other ports or hosts are not followed. Body cap 20 MiB.
- The browser pane renders proxied pages in a sandboxed iframe (`allow-scripts
  allow-forms`, never `allow-same-origin`). An external `https://` URL typed into the
  address bar is not proxied: the pane offers "Open in a new browser tab".

### Suggested

`GET /api/workbench/suggestions` combines services, extension UIs from the
existing catalogue and the five most recent pages, each `{ kind, title, target }`.
Only things that exist right now appear.

### Extensions

"More tools" lists installed, enabled extensions with a UI from `snapshot.extensions`
and mounts them with the existing `/extensions/<hash>/client.js` module loader.

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
