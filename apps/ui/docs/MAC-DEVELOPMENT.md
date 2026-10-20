# Mac development

Use the [root setup](../../../README.md) to run Pi and the UI on the same machine.
Both workspaces use the root npm lockfile and pinned Node24.14.0.

To run only the UI locally while Pi stays on a private remote machine, create
`apps/ui/.env.local` from `apps/ui/.env.example`. Set `MARS_PI_ORIGIN` to the
private Pi HTTPS origin and `MARS_PI_TOKEN` to the owner token from its sign-in
link. Never commit this file. The token grants owner access to the remote agent,
including its filesystem, network and sudo permissions when enabled.

From the monorepo root:

```sh
npm ci
cp apps/ui/.env.example apps/ui/.env.local
# Edit apps/ui/.env.local with the private origin and token.
npm run dev --workspace mars-ui
```

Open http://127.0.0.1:3082. Next Fast Refresh applies local UI source edits.
`MARS_UI_PORT` selects another port. `MARS_PUBLIC_ORIGIN` accepts an exact private
proxy origin for development assets and HMR, and grants no owner API access.
API proxy requests still require a local page origin and reject cross-site writes.
The proxy stays disabled unless both private settings exist. Credentials remain
server-side. The Pi gateway handles its own API routes before forwarding to Next.

Local and remote checkouts are separate. Agent edits on the remote machine do not
edit Mac files. Exchange source through Git, with separate branches or worktrees
for concurrent agents. A browser disconnect never cancels a durable Pi run.

```sh
npm run typecheck
npm run lint
npm test
npm exec --workspace mars-ui playwright install chromium
npm run test:ui --workspace mars-ui
```

Browser checks use the installed pinned Playwright Chromium. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for a custom browser. `MARS_UI_BASE_URL`
overrides the browser check target. The optional existing-host check requires
`MARS_LIVE_HOST_CHECK=1`, a configured `MARS_PI_ROOT` or `MARS_PI_TOKEN_FILE`, and
the actual private `MARS_PI_ORIGIN`. It expects the existing Mock Discord fixture
and Claude connection. Fixture checks need no live account or model request.
