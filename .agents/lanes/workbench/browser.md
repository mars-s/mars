# Lane: browser and services

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/wb-browser`, branch `codex/wb-browser`, UI port **3235**.
Contract: docs/WORKBENCH.md "Services and browser". Host module
`packages/pi-host/workbench/browser.mjs` (must export `services()` used by
suggestions), check `check-workbench-browser.mjs`. Pane
`apps/ui/components/workbench/browser-pane.tsx` (+ css) and
`extension-pane.tsx` (you also own the `extension` case in panes.tsx: mount the
installed extension UI exactly like `components/settings/extensions-page.tsx`
`ExtensionPanel` does), browser check `apps/ui/tests/workbench-browser-check.mjs`.

Services: loopback TCP listeners via `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS) or
`ss -Hltnp` (Linux), parse to ports bound on 127.0.0.1, ::1, localhost or *, exclude
the host port, UI port and anything in `MARS_WORKBENCH_EXCLUDE_PORTS`, probe each with
GET / (1.5 s) and keep only HTTP answers with the `<title>` when HTML. Cache 10 s.
`available()` false with a reason if neither lsof nor ss exists.

Proxy: `/api/workbench/browse/<port>/<path>` exactly per the contract (allowed ports
only, header stripping both ways, sandbox CSP, no cross-port redirects: rewrite
`Location` to the proxied path only when it points at the same port, otherwise
return the redirect as a 502 JSON error). Rewrite root-relative URLs? No: instead
inject `<base href="/api/workbench/browse/<port>/">` into HTML `<head>` responses so
relative assets load through the proxy; leave other content untouched. Body cap 20 MiB.
Note the host's own CSP `frame-ancestors 'none'` applies to Mars pages, and proxied
responses must allow being framed by Mars itself (`frame-ancestors 'self'`).

UI: address bar, back/forward/reload (iframe history via your own stack), the iframe
with `sandbox="allow-scripts allow-forms allow-popups"` (never allow-same-origin),
loading and error states, "Open in new tab" for external URLs (`browseTarget` in
`lib/pi/workbench.ts` already classifies input). The tab's `url` is kept via
`dispatch({type:"update"})`. Check: 401, disallowed port 403, header stripping,
CSP sandbox present, base injection, redirect handling, cap, services discovery
finds a test HTTP server you start and ignores a non-HTTP listener.
