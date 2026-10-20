# Current Mars

The owner replaced the ZCode fork and DeepSeek trial with Pi Durable1.3.0 and the
Next.js Mars UI. The public source is mars-s/mars. There are two npm workspaces:
apps/ui and packages/pi-host. Read docs/MONOREPO.md and docs/ARCHITECTURE.md.

The latest agent work from mars-ui through db85735 is retained: web search,
staged host deployment with health/rollback watchdog, layered config, native
threads/workflows/images and plugin cards. Pi is the only native state owner.
Local font files and upstream component notices retain their provenance.

No native data, tokens or OAuth state belong in Git. Root defaults use XDG paths;
Bot Box cutover explicitly retains the existing private mars-pi-trial data root.
Retiring services does not delete database backups or installed plugin packages.
Owner HTTP auth, full authorised local VM control, deferred tool discovery and
bounded results stay. Codex remote control and Tailscale stay separate.

Bot Box cutover is complete. Canonical source is /home/bot/ChatGPT/mars; active
services are mars-pi-trial.service and mars-pi-ui.service, both generated from this
checkout. The private managed runtime/data root remains mars-pi-trial. Tailnet
HTTPS443 and9443 route to the Pi gateway3081. Old ZCode/Mars/DeepSeek services
and routes are retired, with private cold backups. Public main uses a reviewed
source snapshot and public Mars ancestry, excluding private UI history.
