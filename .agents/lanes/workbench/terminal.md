# Lane: terminal

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/wb-terminal`, branch `codex/wb-terminal`, UI port **3234**.
Contract: docs/WORKBENCH.md "Terminal". Host module `packages/pi-host/workbench/terminal.mjs`
plus `packages/pi-host/workbench/pty-bridge.py`, check `check-workbench-terminal.mjs`.
Pane `apps/ui/components/workbench/terminal-pane.tsx` (+ css), browser check
`apps/ui/tests/workbench-terminal-check.mjs`.

Decided already (see .agents/goals/workbench-log.tsv): node-pty is out (fails on this
Mac, no Linux prebuild). Use a python3 `pty.fork()` bridge: shell output on stdout,
input on stdin, resize lines `R <cols> <rows>` on fd 3. A working prototype is at
`/tmp/pybridge/pty-bridge.py` (verified with stty size and resize). Transport is long
polling over HTTP (works through the Next dev proxy's 25 s timeout and Tailscale): see
the contract's routes. Sessions: max 4, ring buffer 256 KiB with byte offsets, idle
timeout 30 min, kill the whole process group, env limited to PATH, HOME, LANG, TERM,
SHELL, USER, cwd the workspace. Input is never logged. `available()` says
"python3 with the pty module was not found on the host" when missing.

UI: xterm.js (`@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0, exact pins, MIT;
add their licences to `apps/ui/licenses/` and the vendored register is not needed as
they are npm deps). Theme from the Mars tokens (read CSS variables at mount; follow
theme changes). Fit on resize (ResizeObserver) and send resize. Long-poll loop while
the tab exists, backs off on errors, shows "Reconnecting…" and "Session ended (exit N)".
Pane menu: "New session", "End session" (explicit kill). The tab's `sessionId` is
stored via `dispatch({type:"update"})` so a reload reattaches. Lazy-load xterm so it is
not in the main bundle. Add `@xterm/*` to apps/ui package.json with `npm install
--save-exact --workspace mars-ui` (the lockfile change is yours).
Check: 401, create, echo round trip, resize reflected by `stty size`, offsets and
`dropped`, input cap, max sessions, kill ends the group, idle timeout (make it
configurable via env for the test).
