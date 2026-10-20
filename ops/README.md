# User services

From the checkout, run `npm run install:service` to write Linux systemd user units.
It creates no model requests and does not start services until you pass `--enable`.
Use `--mode development` for Next.js hot reload, or build first for the default
production mode. Root builds and production start use `.next-build`, leaving the
`.next` development cache separate. Both services listen on loopback.

Use `MARS_PI_ROOT` to retain an existing private data directory. The installer uses
the current checkout and Node executable, including paths containing spaces. It
keeps the owner token, provider credentials, conversations and installed plugins.
Service configuration lives in the private data directory as `service.env` with
mode 0600. No credentials are stored in the checkout.

`--dry-run` prints the proposed units without writing files or calling systemd.
`--config-dir /tmp/example --no-systemd` writes test units without touching the
current user's service manager. `MARS_HOST_SERVICE` and `MARS_UI_SERVICE` select
existing service names deliberately. Systemd user services normally start at
login. Enable lingering separately if you want them to start before login.

The documented launcher requires a util-linux-compatible `flock`, resolved through
`MARS_FLOCK_PATH` or `PATH`. Setup fails clearly when it is missing. Install a
compatible executable before starting a local host on macOS. Native macOS
operation has not been verified. The host holds `data/host.lock` before loading
Pi or opening SQLite. Manual and service launches share this lock even when they
use different HTTP ports. An already running host rejects a second launch.

Bootstrap creates the private `app` runtime from `packages/pi-host` only when that
runtime is absent. It records the workspace lock and links installed dependencies.
Later setup and service starts preserve the existing runtime, including deployed
or owner-authored changes. Git checkout edits stay separate from running host
files. Use staged `host_deploy` to apply a later checkout deliberately.
