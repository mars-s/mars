# Lane: files

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/wb-files`, branch `codex/wb-files`, UI port **3231**.
Contract: docs/WORKBENCH.md "Files". Host module `packages/pi-host/workbench/files.mjs`,
check `check-workbench-files.mjs`. Pane `apps/ui/components/workbench/files-pane.tsx`
(+ `files-pane.css`), browser check `apps/ui/tests/workbench-files-check.mjs`.

Build: a two-column pane (tree on the left, viewer on the right; stacked on narrow
widths) of the Pi workspace. Breadcrumbs, folder expand/collapse, quick open (Cmd/Ctrl+P
inside the pane, filename search via `/api/workbench/search`), file viewer: Markdown
rendered (reuse `react-markdown` + `remark-gfm` like the thread), code as mono text with
line numbers, images from `/api/workbench/raw`, binaries as "Binary file, N KB" with
size. Read-only. The tab's `path` (via `dispatch({type:"update"})`) tracks the open file
so reload reopens it. Host: listings capped at 2,000 entries with `truncated`, file text
capped at 2 MiB, `raw` only for images (sniff the first bytes, never trust the
extension alone), search skips `node_modules` and `.git`, max 200 results and 3 s.
Check: 401, `../` and symlink escape 403, listing, text, image, binary, caps, search.
