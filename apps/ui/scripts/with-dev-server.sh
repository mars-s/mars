#!/usr/bin/env bash
# Start the UI dev server on MARS_UI_PORT, wait for it, run the given command, then stop it.
# Usage: MARS_UI_PORT=3190 scripts/with-dev-server.sh node tests/live-client-check.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
port="${MARS_UI_PORT:-3190}"
export MARS_UI_PORT="$port"
log="/tmp/mars-dev-$port.log"
node scripts/next.mjs dev >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  if curl -fs -o /dev/null "http://127.0.0.1:$port/"; then break; fi
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$port/" || { echo "dev server did not start; see $log"; exit 1; }
"$@"
