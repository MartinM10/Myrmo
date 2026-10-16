#!/usr/bin/env bash
# Deploys the colony on the production server. It runs as the forced command of the deploy key
# (see docs/operate/deployment.md): the key cannot open a shell, it can only run this script.
#
# Input:   the commit id as the SSH command argument (it arrives in $SSH_ORIGINAL_COMMAND), nothing else.
#          Anything sent on stdin is read and thrown away (older workflows sent an archive there).
# Source:  the server fetches main from the public repository itself (REPO_URL below, never taken from the
#          caller) into a bare clone, and deploys the commit only if it is already part of main. Whoever holds
#          the key can redeploy a commit of main, and nothing else: no code, archive or compose file of their own.
# Safety:  1. back up the data first, with the backup script of the verified commit, and abort if that fails
#          2. build the new images BEFORE touching what is running: a failed build changes nothing
#          3. swap the directory, recreate only the services whose image changed
#          4. wait for the gateway, the hosted MCP server and the website to answer
#          5. if they do not, put the previous version back and exit non-zero
# State:   .env stays on the server and is carried over; volumes are never removed.
set -euo pipefail

# The only place code comes from. MYRMO_DEPLOY_REPO exists for tests (a local repository): it can be set only in the
# server's own environment, since an SSH client cannot set variables for a forced command unless sshd's AcceptEnv
# lists them (it does not, by default) and authorized_keys is not the caller's to edit.
REPO_URL="https://github.com/MartinM10/Myrmo.git"
REPO_URL="${MYRMO_DEPLOY_REPO:-$REPO_URL}"
SRC="${MYRMO_DEPLOY_SRC:-$HOME/myrmo-src.git}"
APP="${MYRMO_APP_DIR:-$HOME/myrmo}"
NEW="$APP.incoming"
PREV="$APP.prev"
FAILED="$APP.failed"
LOG="${MYRMO_DEPLOY_LOG:-$HOME/myrmo-deploys.log}"
SHA="${SSH_ORIGINAL_COMMAND:-}"
WAIT_SECONDS="${MYRMO_DEPLOY_WAIT:-240}"

# Whatever arrives on stdin is drained in the background, so a client that still sends an archive is not cut off
# halfway (its `git archive | ssh` would fail on a broken pipe). Nothing in this script reads it. The explicit <&0
# matters: without it, bash gives a background command /dev/null as its input.
cat <&0 >/dev/null 2>&1 &
exec </dev/null

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG" >&2; }
compose() { docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml "$@"; }
src_git() { GIT_TERMINAL_PROMPT=0 git -C "$SRC" "$@"; }

if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: ssh deploy@host <40-character commit id of main>" >&2
  exit 2
fi

# One deploy at a time, whoever started it.
exec 9>>"$HOME/.myrmo-deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

log "deploy $SHA: fetching main from $REPO_URL"
[ -d "$SRC" ] || git init --quiet --bare "$SRC"
src_git fetch --quiet --prune --no-tags "$REPO_URL" "+refs/heads/main:refs/heads/main" >> "$LOG" 2>&1 \
  || { log "deploy $SHA: could not fetch main, nothing changed"; exit 1; }
src_git cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { log "deploy $SHA: no such commit in the repository, refusing"; exit 1; }
src_git merge-base --is-ancestor "$SHA" refs/heads/main \
  || { log "deploy $SHA: not on main, refusing"; exit 1; }

log "deploy $SHA: extracting"
rm -rf "$NEW" "$FAILED"
mkdir -p "$NEW"
# Never restore ownership or permissions from the archive.
src_git archive --format=tar "$SHA" | tar -x --no-same-owner --no-same-permissions -C "$NEW" \
  || { log "deploy $SHA: could not extract the commit"; rm -rf "$NEW"; exit 1; }
[ -f "$NEW/docker-compose.yml" ] && [ -f "$NEW/deploy/docker-compose.prod.yml" ] && [ -f "$NEW/deploy/backup.sh" ] \
  || { log "deploy $SHA: not a Myrmo commit"; rm -rf "$NEW"; exit 1; }
[ -f "$APP/.env" ] || { log "deploy $SHA: $APP/.env is missing"; rm -rf "$NEW"; exit 1; }
cp "$APP/.env" "$NEW/.env"
chmod 600 "$NEW/.env"
echo "$SHA" > "$NEW/.deployed-sha"

# The backup script of the commit just verified, not the one in the running tree: whatever was deployed before has
# no say in what runs now.
log "deploy $SHA: backing up data"
(cd "$APP" && bash "$NEW/deploy/backup.sh") >> "$LOG" 2>&1 \
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
