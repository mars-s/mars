# Private Next.js hosting contract

The existing Pi HTTP process on loopback3081 owns authentication, OAuth, SQLite,
tools and model execution. Next.js on loopback3082 owns rendering and Fast Refresh.
The authenticated Pi gateway forwards non-API page/asset requests and authenticated
WebSocket upgrades to Next. Tailscale HTTPS9443 keeps its existing mapping.
Browser disconnection closes observation only, never a durable Pi submission.

No Next public environment variable contains a credential. The gateway retains its
HttpOnly cookie, host checks and POST origin checks. Development requires inline
hydration scripts and eval in its private development CSP. This is a private
development service, not a production deployment configuration.

Acceptance: unauthenticated HTML/API/HMR denied, authenticated page and API work,
cross-origin POST and HMR denied, a source edit updates an already-open page,
backend restart preserves conversation and extension catalogue. A failed UI build
must leave live source unchanged. Existing Pi conversations, credentials and plugins remain intact during migration.

Flow: browser -> private HTTPS -> Pi authentication -> API owner or Next renderer.
Pi tool -> staged UI snapshot -> checks -> guarded promotion -> Next Fast Refresh.
