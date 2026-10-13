#!/usr/bin/env bash
# A team's private colony on one machine (Linux with Docker), in one command, plus what you need afterwards.
#
#   MYRMO_ALLOWED_NETWORKS=192.168.219.0/24 bash deploy/private-colony.sh up
#                                                    # build and start it; keys required, only that network may connect
#   bash deploy/private-colony.sh keys add ana       # a person's access key (shown once) with a message ready to send them
#                                                    # also: keys list, keys revoke ana, invite ana <key>
#   bash deploy/private-colony.sh report [days]      # what each person did with it, and reuse between people
#   bash deploy/private-colony.sh status             # is it up, and does it refuse a request without a key
#   bash deploy/private-colony.sh backup             # one archive of everything it knows (deploy/backup.sh)
#   bash deploy/private-colony.sh down               # stop it; the data stays in its Docker volumes
#
# Run it from the repository's root. The settings it creates once live in .env.private (readable only by you): the
# operator token and the salt are random, keys are required (MYRMO_REQUIRE_KEY=1), and no decision model is used, so
# only the colony's deterministic rules judge new trails and nothing is sent to any outside service. MYRMO_PORT changes
# the port (default 8080). Only the networks in MYRMO_ALLOWED_NETWORKS may connect (the first `up` asks for them, so a
# colony is never opened to a whole building by accident; `any` opens it). MYRMO_COLONY_URL is the address people use
# (default http://<this machine's first address>:<port>). Each person then sets up their machine with the message
# `keys add` prints.
set -euo pipefail

PROJECT="${MYRMO_PROJECT:-myrmo-private}"
ENV_FILE="${MYRMO_ENV_FILE:-.env.private}"
PORT="${MYRMO_PORT:-8080}"
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

[ -f docker-compose.yml ] || { echo "Run this from the root of the Myrmo repository." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker with the compose plugin is needed (docker compose version)." >&2; exit 1; }

# A request from inside the gateway's container: through the published port, the machine itself reaches the colony from
# Docker's own network, which MYRMO_ALLOWED_NETWORKS does not list (and should not).
inside() { local path="$1"; shift; compose exec -T gateway curl -s "$@" "http://127.0.0.1:8080$path"; }

# The address people use: MYRMO_COLONY_URL from .env.private, else this machine's first address and the port.
colony_url() {
  local url=""
  [ -f "$ENV_FILE" ] && url=$(sed -n 's/^MYRMO_COLONY_URL=//p' "$ENV_FILE" | head -n 1)
  [ -n "$url" ] || url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
  echo "$url"
}

# The message to send a person: what the colony is, what they need, the one command, and how to check it worked.
invite() {
  local name="$1" key="$2" url
  url=$(colony_url)
  cat <<MSG

----- send this to $name, privately (the key is shown only now) -----
Hi $name,

We now have a shared memory for our coding agents: when your agent solves an error, the next agent that hits it
gets the solution automatically. It runs on our own machine; nothing goes to the internet. You need the team network.

You need: Node.js 20 or newer (node --version) and Claude Code and/or Antigravity.

1. Run this once (it sets up the agents on your machine):

   npx myrmo-mcp@latest init --url $url --key $key --private --publish auto

2. Restart Claude Code / Antigravity. In Antigravity, accept the permission for the myrmo tools ("always").
3. Check it:   npx myrmo-mcp@latest doctor     (it says what to fix, if anything)

The command is in your shell history with the key in it: delete that line (history -d) or edit it out.
What it does: your agent looks the error up when a command fails, and shares what it solved with the team. Credentials,
people's names, e-mails and customer data are removed; internal tool and service names are kept on purpose. Tell the
person who set this up if something looks wrong or gets in the way.
----------------------------------------------------------------------
MSG
}

case "${1:-}" in
  up)
    if [ ! -f "$ENV_FILE" ]; then
      if [ -z "${MYRMO_ALLOWED_NETWORKS:-}" ]; then
        echo "Say which network may connect, for example:" >&2
        echo "  MYRMO_ALLOWED_NETWORKS=192.168.219.0/24 bash deploy/private-colony.sh up" >&2
        echo "(several: separate them with commas; a single address works too; 'any' leaves it open to whoever can reach it)" >&2
        exit 2
      fi
      allowed="$MYRMO_ALLOWED_NETWORKS"; [ "$allowed" = any ] && allowed=""
      umask 077
      cat > "$ENV_FILE" <<EOF
# A private colony (deploy/private-colony.sh). Keep this file: the salt keeps daily client hashes stable across restarts.
MYRMO_REQUIRE_KEY=1
MYRMO_DECISION_URL=
MYRMO_ALLOWED_NETWORKS=$allowed
MYRMO_COLONY_URL=${MYRMO_COLONY_URL:-}
MYRMO_ADMIN_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
MYRMO_SALT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
EOF
      echo "Created $ENV_FILE (keys required, no external decision service)."
    fi
    # --build: the server image must be this checkout's, never an older one left on the machine.
    compose up -d --build --no-deps valkey qdrant embed gateway enricher
    echo "Waiting for the colony (the first start downloads the embedding model)..."
    for _ in $(seq 1 120); do inside /healthz >/dev/null && break; sleep 3; done
    "$0" status
    echo
    echo "Address for your team: $(colony_url)"
    echo "Admin panel: $(colony_url)/admin   (the operator token is MYRMO_ADMIN_TOKEN in $ENV_FILE)"
    echo "Next: one key per person:   bash deploy/private-colony.sh keys add <name>"
    ;;
  status)
    health=$(inside /readyz -o /dev/null -w '%{http_code}' || true)
    nokey=$(inside /v1/search -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d '{"query":"check without a key"}' || true)
    echo "ready: $health (200 expected)   a request without a key: $nokey (401 expected)"
    [ "$health" = 200 ] && [ "$nokey" = 401 ]
    ;;
  keys)
    shift
    if [ "${1:-}" = add ] && [ -n "${2:-}" ]; then
      key=$(compose exec -T gateway myrmo-server keys add "$2" 2>/dev/null) || { echo "Could not create the key for $2." >&2; exit 1; }
      invite "$2" "$key"
    else
      compose exec -T gateway myrmo-server keys "$@"
    fi
    ;;
  invite)
    # Prints the message for a person who already has a key (the key itself is never stored, so you give it again).
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "Usage: invite <name> <their key>" >&2; exit 2; }
    invite "$2" "$3"
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
