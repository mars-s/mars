#!/bin/bash
# Applies a staged host deploy, restarts the service and rolls back if it is unhealthy.
# Runs as an independent systemd --user unit so it survives the restart it performs.
set -u
DIR=$1 APP=$2 SERVICE=$3 PORT=$4 ROOT=$5
STAGE=$DIR/stage/app
ATTEMPTS=${MARS_DEPLOY_HEALTH_ATTEMPTS:-45}
INTERVAL=${MARS_DEPLOY_HEALTH_INTERVAL:-2}
SYSTEMCTL=${MARS_DEPLOY_SYSTEMCTL:-systemctl}

log() { echo "$(date -Is) $*" >> "$DIR/watchdog.log"; }
# Each status records this watchdog's pid and start time, so host_deploy_status can
# tell a deploy whose watchdog died (status "interrupted") from one still running.
status() {
  STATUS="$1" DETAIL="$2" OUT="$DIR/status.json" WD_PID=$ node -e '
    const fs = require("fs"); const env = process.env; const tmp = env.OUT + ".wd.tmp";
    let prior = {}; try { prior = JSON.parse(fs.readFileSync(env.OUT, "utf8")); } catch {}
    let pidStart = null; try { const s = fs.readFileSync("/proc/" + env.WD_PID + "/stat", "utf8"); pidStart = s.slice(s.lastIndexOf(")") + 2).split(" ")[19] || null; } catch {}
    fs.writeFileSync(tmp, JSON.stringify({ startedAt: prior.startedAt, commit: prior.commit, subject: prior.subject, pid: Number(env.WD_PID), pidStart, status: env.STATUS, at: new Date().toISOString(), detail: env.DETAIL }), { mode: 0o600 });
    fs.renameSync(tmp, env.OUT);'
  log "status $1"
}
healthy() {
  local i
  for ((i = 0; i < ATTEMPTS; i++)); do
    if $SYSTEMCTL --user is-active --quiet "$SERVICE" && [ -f "$ROOT/data/web-token" ] &&
      curl -fsS -m 5 -o /dev/null -H "Authorization: Bearer $(cat "$ROOT/data/web-token")" "http://127.0.0.1:$PORT/api/state" 2>/dev/null; then
      return 0
    fi
    sleep "$INTERVAL"
  done
  return 1
}
journal() { journalctl --user -u "$SERVICE" -n 40 --no-pager 2>/dev/null | tail -c 3000; }

status applying "Copying staged files"
SWAPPED=0
if [ -f "$DIR/deps-changed" ]; then
  rm -rf "$APP/node_modules.prev"
  if [ -e "$APP/node_modules" ] || [ -L "$APP/node_modules" ]; then mv "$APP/node_modules" "$APP/node_modules.prev" || { status apply_failed "dependency backup failed"; exit 1; }; fi
  if cp -a "$STAGE/node_modules" "$APP/node_modules"; then SWAPPED=1; else
    [ ! -e "$APP/node_modules.prev" ] && [ ! -L "$APP/node_modules.prev" ] || mv "$APP/node_modules.prev" "$APP/node_modules"
    status apply_failed "node_modules swap failed"; exit 1
  fi
fi
shopt -s dotglob nullglob
for entry in "$STAGE"/*; do
  name=$(basename "$entry")
  [ "$name" = node_modules ] && continue
  cp -a --remove-destination "$entry" "$APP/" || { log "copy failed: $name"; COPY_FAILED=1; }
done
status restarting "Restarting $SERVICE"
$SYSTEMCTL --user restart "$SERVICE"
if [ -z "${COPY_FAILED:-}" ] && healthy; then
  # Tell the live host which commit it runs (GET /api/host/version reads this).
  PLAN="$DIR/plan.json" OUT="$APP/deployed.json" ID=$(basename "$DIR") node -e '
    const fs = require("fs"); const env = process.env; const plan = JSON.parse(fs.readFileSync(env.PLAN, "utf8"));
    fs.writeFileSync(env.OUT + ".tmp", JSON.stringify({ commit: plan.commit, subject: plan.subject, ref: plan.ref, id: env.ID, deployedAt: new Date().toISOString() }, null, 1) + "\n");
    fs.renameSync(env.OUT + ".tmp", env.OUT);' || log "could not write deployed.json"
  status deployed "$SERVICE healthy on port $PORT"
  rm -rf "$APP/node_modules.prev"
  [ -L "$STAGE/node_modules" ] || rm -rf "$STAGE/node_modules"
  exit 0
fi

REASON="Unhealthy after deploy. $(journal)"
log "rolling back"
while IFS= read -r file; do [ -n "$file" ] && rm -f "$APP/$file"; done < "$DIR/added.txt"
tar -xzf "$DIR/backup.tgz" -C "$APP"
if [ "$SWAPPED" = 1 ]; then rm -rf "$APP/node_modules"; if [ -e "$APP/node_modules.prev" ] || [ -L "$APP/node_modules.prev" ]; then mv "$APP/node_modules.prev" "$APP/node_modules"; fi; fi
$SYSTEMCTL --user restart "$SERVICE"
if healthy; then status rolled_back "$REASON"; else status rollback_failed "$REASON | after rollback: $(journal)"; fi
exit 1
