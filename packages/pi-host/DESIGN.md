# Host interface boundary

The production interface lives in `apps/ui`. Follow its design specification and
reuse its conversation runtime, local Sans/Serif/Mono fonts and shared controls.
Keep the main chat quiet. Settings contains account, model and environment details;
Extensions displays catalogue-driven cards and plugin, tool and interface controls.

Subthreads are independent conversations. Workflows are ordered background phases.
Show real model/tool progress and reported usage. Images persist as references,
with thumbnails and removal controls before submission. Responsive layouts and
reduced-motion behaviour are part of the interface contract.

The host proxies the loopback UI port selected by `MARS_UI_PORT`. It owns HTTP
credentials and exact configured origin checks. Browser state never replaces
native Pi conversations, tasks or recovery state.
