# Verification

Use pinned Node24.14.0 and the single npm workspace lock. Read docs/INSTALL.md for
actual install/start commands and docs/MIGRATION-RESULTS.md for this cutover.

Run root typecheck, lint, architecture:check, tests, browser fixtures and build.
Native checks use isolated databases and deterministic providers. A fresh-install
check must use a new temporary MARS_PI_ROOT and must make no real model calls.
The separate live check reads an owner token privately and compares native
history/model/plugin state, never logs secrets or creates paid model traffic.

Do not substitute historical ZCode/DeepSeek checks or old demo test totals for
current results. Browser fixtures do not prove real provider access. Mac execution
is separate from checks run on Debian Bot Box. Disabled old services and cold
backup data are not active dependencies.
