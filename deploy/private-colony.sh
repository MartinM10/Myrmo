#!/usr/bin/env bash
# A team's private colony on one machine (Linux with Docker), in one command, plus what you need afterwards.
#
#   bash deploy/private-colony.sh up                 # build and start it; access keys required, no external service
#   bash deploy/private-colony.sh keys add ana       # a person's access key (shown once); also: keys list, keys revoke ana
#   bash deploy/private-colony.sh report [days]      # what each person did with it, and reuse between people
#   bash deploy/private-colony.sh status             # is it up, and does it refuse a request without a key
#   bash deploy/private-colony.sh backup             # one archive of everything it knows (deploy/backup.sh)
#   bash deploy/private-colony.sh down               # stop it; the data stays in its Docker volumes
#
# Run it from the repository's root. The settings it creates once live in .env.private (readable only by you): the
# operator token and the salt are random, keys are required (MYRMO_REQUIRE_KEY=1), and no decision model is used, so
# only the colony's deterministic rules judge new trails and nothing is sent to any outside service. MYRMO_PORT changes
# the port (default 8080). Each person then sets up their machine with one command, which `keys add` prints.
set -euo pipefail

PROJECT=myrmo-private
ENV_FILE=.env.private
PORT="${MYRMO_PORT:-8080}"
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

[ -f docker-compose.yml ] || { echo "Run this from the root of the Myrmo repository." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker with the compose plugin is needed (docker compose version)." >&2; exit 1; }

case "${1:-}" in
  up)
    if [ ! -f "$ENV_FILE" ]; then
      umask 077
      cat > "$ENV_FILE" <<EOF
# A private colony (deploy/private-colony.sh). Keep this file: the salt keeps daily client hashes stable across restarts.
MYRMO_REQUIRE_KEY=1
MYRMO_DECISION_URL=
MYRMO_ADMIN_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
MYRMO_SALT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
EOF
      echo "Created $ENV_FILE (keys required, no external decision service)."
    fi
    # --build: the server image must be this checkout's, never an older one left on the machine.
    compose up -d --build --no-deps valkey qdrant embed gateway enricher
    echo "Waiting for the colony (the first start downloads the embedding model)..."
    for _ in $(seq 1 120); do curl -sf "http://localhost:$PORT/healthz" >/dev/null && break; sleep 3; done
    "$0" status
    echo
    echo "Next: one key per person:   bash deploy/private-colony.sh keys add <name>"
    ;;
  status)
    health=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/readyz" || true)
    nokey=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/v1/search" \
      -H 'content-type: application/json' -d '{"query":"check without a key"}' || true)
    echo "ready: $health (200 expected)   a request without a key: $nokey (401 expected)"
    [ "$health" = 200 ] && [ "$nokey" = 401 ]
    ;;
  keys)
    shift
    compose exec -T gateway myrmo-server keys "$@"
    ;;
  report)
    compose exec -T gateway myrmo-server team-report "${2:-7}"
    ;;
  backup)
    MYRMO_PROJECT="$PROJECT" bash deploy/backup.sh
    ;;
  down)
    compose stop
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
