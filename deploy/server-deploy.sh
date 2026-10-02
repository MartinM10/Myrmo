#!/usr/bin/env bash
# Deploys the colony on the production server. It runs as the forced command of the deploy key
# (see docs/operate/deployment.md): the key cannot open a shell, it can only run this script.
#
# Input:   a tar archive of the repository on stdin (`git archive HEAD`), and the commit id as the
#          SSH command argument (it arrives in $SSH_ORIGINAL_COMMAND).
# Safety:  1. back up the data first, and abort if that fails
#          2. build the new images BEFORE touching what is running: a failed build changes nothing
#          3. swap the directory, recreate only the services whose image changed
#          4. wait for the gateway, the hosted MCP server and the website to answer
#          5. if they do not, put the previous version back and exit non-zero
# State:   .env stays on the server and is carried over; volumes are never removed.
set -euo pipefail

APP="${MYRMO_APP_DIR:-$HOME/myrmo}"
NEW="$APP.incoming"
PREV="$APP.prev"
FAILED="$APP.failed"
LOG="${MYRMO_DEPLOY_LOG:-$HOME/myrmo-deploys.log}"
SHA="${SSH_ORIGINAL_COMMAND:-}"
WAIT_SECONDS="${MYRMO_DEPLOY_WAIT:-240}"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG" >&2; }
compose() { docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml "$@"; }

if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: ssh deploy@host <40-character commit id>   (archive on stdin)" >&2
  exit 2
fi

log "deploy $SHA: receiving"
rm -rf "$NEW" "$FAILED"
mkdir -p "$NEW"
# Cap the size and never restore ownership or absolute paths from the archive.
head -c 300M | tar -x --no-same-owner --no-same-permissions -C "$NEW"
[ -f "$NEW/docker-compose.yml" ] && [ -f "$NEW/deploy/docker-compose.prod.yml" ] \
  || { log "deploy $SHA: not a Myrmo archive"; rm -rf "$NEW"; exit 1; }
[ -f "$APP/.env" ] || { log "deploy $SHA: $APP/.env is missing"; rm -rf "$NEW"; exit 1; }
cp "$APP/.env" "$NEW/.env"
chmod 600 "$NEW/.env"
echo "$SHA" > "$NEW/.deployed-sha"

log "deploy $SHA: backing up data"
(cd "$APP" && bash deploy/backup.sh) >> "$LOG" 2>&1 \
  || { log "deploy $SHA: backup failed, nothing changed"; rm -rf "$NEW"; exit 1; }

log "deploy $SHA: building"
(cd "$NEW" && compose build) >> "$LOG" 2>&1 \
  || { log "deploy $SHA: build failed, nothing changed (see $LOG)"; tail -n 40 "$LOG" >&2; rm -rf "$NEW"; exit 1; }

healthy() {
  (cd "$APP" \
    && compose exec -T gateway curl -sf http://127.0.0.1:8080/readyz >/dev/null \
    && compose exec -T mcp wget -qO- http://127.0.0.1:3333/healthz >/dev/null \
    && compose exec -T web wget -qO- http://127.0.0.1/ >/dev/null) 2>/dev/null
}

wait_healthy() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    healthy && return 0
    sleep 5
  done
  return 1
}

log "deploy $SHA: switching"
rm -rf "$PREV"
mv "$APP" "$PREV"
mv "$NEW" "$APP"
(cd "$APP" && compose up -d --remove-orphans) >> "$LOG" 2>&1 || true

if wait_healthy; then
  log "deploy $SHA: healthy"
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter until=72h >/dev/null 2>&1 || true
  log "deploy $SHA: done"
  exit 0
fi

log "deploy $SHA: NOT healthy after ${WAIT_SECONDS}s, rolling back"
(cd "$APP" && compose logs --tail 40 gateway enricher mcp web 2>&1) | tail -n 80 >&2 || true
mv "$APP" "$FAILED"
mv "$PREV" "$APP"
(cd "$APP" && compose up -d --build --remove-orphans) >> "$LOG" 2>&1 || true
if wait_healthy; then
  log "deploy $SHA: rolled back to the previous version, which is healthy"
else
  log "deploy $SHA: ROLLBACK ALSO UNHEALTHY, needs a person"
fi
exit 1
