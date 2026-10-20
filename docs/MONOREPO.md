# Mars Pi Durable monorepo migration

The owner replaces the ZCode fork and DeepSeek trial with Pi Durable1.3.0 plus the
existing Next.js UI. The repository remains public. Preserve all committed UI
changes through db85735, including native web search, deployment rollback and
default/user/environment configuration. Pi remains the single conversation/task/
usage owner. The migration introduces no second scheduler or model database.

## Layout and contract

- apps/ui: existing Next.js, TypeScript, assistant-ui, shadcn UI and local fonts.
- packages/pi-host: custom Pi Durable HTTP host, native SDK, extensions and tests.
- scripts: portable bootstrap, process launcher and Linux user-service installer.
- npm workspaces, one exact dependency lockfile and pinned Node24.14.0.

Root npm ci installs both workspaces. npm run dev starts Pi and the hot-reloading
UI. npm run build and npm start run production. npm run install:service installs
Linux user services with paths generated from the actual checkout. All data lives
outside Git, default XDG_DATA_HOME/mars, env MARS_PI_ROOT overrides for migration.
No installer creates a fresh DB over an existing one or logs/copies credentials.
Default host3081, UI3082; both bind loopback. Owner HTTP authentication stays.
MARS_PUBLIC_ORIGIN explicitly allows a private proxy origin; MARS_ALLOWED_ORIGINS
adds explicit legacy aliases. No broad host bypass.

Host config is portable: derive repository, UI directory and Node executable from
module locations/process.execPath. MARS_REPO_ROOT/MARS_UI_DIR override deliberately.
The current data root and service names may be retained by explicit environment
variables. Staged self-deployment reads packages/pi-host and UI patch validation
reads apps/ui. Preserve staging health checks and rollback.

Bootstrap supplies a persistent private web token and a local sign-in URL without
external model calls. Never bake owner sign-in state into a clone. A fresh isolated
install must serve the real UI, reject unauthenticated API access, support empty
conversation state and survive restart. Existing live auth/history/plugin hashes
are compared before and after cutover. Browser paste/subthreads/workflows/plugin
controls and local fonts remain intact.

## Migration boundary and acceptance

Public Git history retains the previous Mars main. A private bundle retains the
complete UI ancestry; the public migration copies current reviewed source only.
Personal screenshot archives and private historical blobs are not published. Active
tracked code, dependency manifests, CI and instructions contain no ZCode desktop,
old Mars Strands/PostgreSQL or DeepSeek services. Retire only those exact old user
services/routes on Bot Box after backup. Keep Codex remote control, Tailscale and
the Pi data root. Keep cold legacy data backup outside the active repo.

Test typecheck, lint, UI/native unit tests, all browser fixtures, production build,
a fresh isolated install/start/stop/restart, Linux service install idempotency and
the actual authenticated live route after cutover. Record actual failures.
