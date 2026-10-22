# Install Mars

Mars is Pi Durable with the Next.js Mars UI in one npm workspace repository. It
runs as your operating-system user. Pi's tools can edit local files and run shell
commands with that user's permissions; OS administrator privileges are separate.

## Prerequisites

Use Node24.14.0 and its npm11.9.0. The repository pins both versions. With mise,
run mise install and mise exec -- npm ci. Otherwise install that Node release
before the commands below. Git and a shell are needed for development tools. Local agent startup also needs
flock from util-linux, available on Debian by default. MARS_FLOCK_PATH can select
a compatible executable. The launcher refuses unlocked native database access.
Mac UI-only editing does not need a local agent or flock.

## Run locally

```sh
git clone https://github.com/mars-s/mars.git
cd mars
npm ci
npm run setup
npm run dev
```

Setup prints a local owner sign-in URL. Open that URL to authenticate the browser,
then use Settings to connect ChatGPT or Claude with native Pi sign-in. No account,
secret, conversation or installed user plugin is included in a clone. Setup does
not make model requests. Copy the final OAuth callback URL into the settings
field if the browser callback and agent run on different computers.

The default gateway is http://127.0.0.1:3081 and the Next development server uses
loopback3082. Enter through the gateway so pages, APIs, images, plugins and HMR
share owner authentication. Frontend edits hot reload. Host source edits require
a restart or the staged host_deploy flow. A browser closing does not stop native
background work. Ctrl+C stops processes started by the local launcher.

The host runs a managed snapshot under the private root/app directory. Repeated
setup preserves it. UI source edits hot reload; host source changes need a commit
and a staged update. With the user services installed:

```sh
npm run host:deploy -- --ref HEAD --dry-run
npm run host:deploy -- --ref HEAD
```

The dry run checks the exact Git commit and isolated host boot. Deployment backs
up code, restarts the configured service and rolls back if unhealthy. The same
flow is available to Pi as host_deploy. It requires Linux user services; manual
launch mode does not promise automatic host restarts.

## Update from GitHub

docs/UPDATES.md has the design. On a server with the user services installed:

```sh
npm run update -- check
npm run update -- apply
```

Check fetches main and says whether an update is ready. Apply builds the new version
beside the running one, restarts both services and goes back to the old version if the
new one is unhealthy. Settings, Updates does the same from the browser, and can install
updates automatically. Local commits are merged with main; a merge that conflicts waits
for you (or for Mars, if you ask it to reconcile). Without the user services, stop Mars
first; apply then updates the files and you start Mars again.

## Production and Linux startup

```sh
npm run build
npm start
```

To install and start Linux user services with UI hot reload:

```sh
npm run install:service -- --mode development --enable
```

Use production mode after a build for a production UI. Omit --enable to write the
units without starting them. Use its documented options for an existing data root. Services use paths from the
actual checkout, not Bot Box paths. User services need a running user manager;
user lingering, if desired for startup without login, is an OS administration
choice. The installer does not alter sudoers, expose a public listener or sign
into any external account.

## Data and configuration

The default private root is $XDG_DATA_HOME/mars or ~/.local/share/mars. Set
MARS_PI_ROOT to retain an existing installation's directory. Never copy native
OAuth credentials into the repository. Back up the native database consistently,
plus private installed plugin/image/config stores. Setup preserves existing data,
web token and owner-edited guides.

Configuration layers are committed defaults, user configuration outside the
checkout, then explicit environment. See packages/pi-host/defaults.json and
apps/ui/docs/CONFIG-LAYERS.md. MARS_CONFIG_DIR overrides the configuration folder.

Important environment settings:

| Variable | Purpose |
| --- | --- |
| MARS_PI_ROOT | Private state and workspace root |
| MARS_REPO_ROOT | Repository checkout for self-deployment |
| MARS_UI_DIR | UI source/build directory, normally apps/ui |
| MARS_PI_PORT | Gateway port, default3081 |
| MARS_UI_PORT | Next port, default3082 |
| MARS_PUBLIC_ORIGIN | Explicit trusted proxy origin |
| MARS_ALLOWED_ORIGINS | Explicit additional proxy origins |
| MARS_PI_SERVICE | Native host service name for self-deployment |
| MARS_UPDATE_CHECK_HOURS | Hours between update checks, default 6; 0 turns them off |
| MARS_UPDATE_REMOTE, MARS_UPDATE_BRANCH | Where updates come from, default origin and main |
| MARS_GATEWAY_TELEGRAM | `1` starts the Telegram chat client (docs/GATEWAY.md) |
| MARS_TELEGRAM_TOKEN | Telegram bot token from BotFather |
| MARS_TELEGRAM_OWNER | Your own Telegram user id(s), comma separated |
| MARS_GATEWAY_DISCORD | `1` starts the Discord chat client, using the bot token saved in Settings, Apps, or MARS_DISCORD_TOKEN |
| MARS_DISCORD_OWNER | Your own Discord user id(s), comma separated |
| MARS_DISCORD_MESSAGE_CONTENT | `1` asks for the privileged Message Content intent (enable it in the Discord Developer Portal first); without it, server messages must mention the bot |

For private Tailscale access, proxy the gateway and configure the exact HTTPS
origin. This setup does not publish a public internet service or provision a node.
For a Mac UI editing an existing remote host, see apps/ui/docs/MAC-DEVELOPMENT.md.
Keep its bridge token server-only in .env.local. It is not a browser env variable.

## Chat with Mars from Telegram or Discord

docs/GATEWAY.md has the design. To turn on Telegram:

1. Create a bot with BotFather and copy its token.
2. Find your own Telegram user id (for example by messaging @userinfobot).
3. Put the variables above in the host's environment (the user service environment file, never Git), set `MARS_GATEWAY_TELEGRAM=1`, and restart the host.
4. Message your bot. Settings, Gateway shows it running and the chat as a linked conversation.

Messages from anyone else get a pairing code and are not passed to Mars until you approve
the code in Settings, Gateway. Approving gives that person the same power as you.

## Verify

```sh
npm run typecheck
npm run lint
npm run architecture:check
npm test
npm run test:ui
npm run build
npm run test:smoke
```

Native tests use deterministic providers and temporary state. UI browser fixtures
require a running Next development server and Playwright Chromium, or an explicit
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. The smoke test checks a fresh production
installation and restart without real accounts or paid model traffic. Refer to
root package scripts for the exact current commands.
