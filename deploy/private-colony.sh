#!/usr/bin/env bash
# An organisation's private colony on one machine (Linux with Docker), in one command, plus what you need afterwards.
#
#   MYRMO_ALLOWED_NETWORKS=10.20.0.0/24 bash deploy/private-colony.sh up
#                                                    # build and start it; keys required, only that network may connect
#   bash deploy/private-colony.sh keys add ana       # a person's access key (shown once) with a message ready to send them
#                                                    # also: keys list, keys revoke ana, invite ana <key>
#   bash deploy/private-colony.sh stats              # what the colony knows: fixes, procedures, facts, and how healthy
#   bash deploy/private-colony.sh gaps               # task requests nobody's knowledge answered (when recording is on)
#   bash deploy/private-colony.sh report [days]      # what the team did with it, and reuse between people
#   bash deploy/private-colony.sh status             # is it up, and does it refuse a request without a key
#   bash deploy/private-colony.sh doctor             # every check, with what to do about each failure
#   bash deploy/private-colony.sh upgrade            # pull this checkout, rebuild and restart; data and keys stay
#   bash deploy/private-colony.sh backup [schedule]  # one archive now, or a daily one at 03:17 (cron, two weeks kept)
#   bash deploy/private-colony.sh logs [service]     # follow the logs (gateway, enricher, embed, qdrant, valkey)
#   bash deploy/private-colony.sh down               # stop it; the data stays in its Docker volumes
#
# Run it from the repository's root. The settings it creates once live in .env.private (readable only by you): the
# operator token and the salt are random, keys are required, the colony is in organisation mode (it keeps your
# network's addresses and host names, accepts procedures and facts as well as fixes, and never rejects a trail for
# "sensitive content"), its task index answers "what do we know about this task?", and no decision model is used, so
# nothing is sent to any outside service. MYRMO_PORT changes the port (default 8080). Only the networks in
# MYRMO_ALLOWED_NETWORKS may connect (the first `up` asks for them; `any` opens it). MYRMO_COLONY_URL is the address
# people use (default http://<this machine's first address>:<port>). Each person then sets up their machine with the
# message `keys add` prints. Most settings can also be changed from the admin panel while the colony runs.
set -euo pipefail

PROJECT="${MYRMO_PROJECT:-myrmo-private}"
ENV_FILE="${MYRMO_ENV_FILE:-.env.private}"
PORT="${MYRMO_PORT:-8080}"
TASK_MODEL="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
# The settings file is the source of truth once written: a MYRMO_ALLOWED_NETWORKS left in the shell from the first `up`
# (or `any`) would otherwise win over it, since compose prefers the shell's variables to the env file's.
compose() { env -u MYRMO_ALLOWED_NETWORKS docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

[ -f docker-compose.yml ] || { echo "Run this from the root of the Myrmo repository." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker with the compose plugin is needed (docker compose version)." >&2; exit 1; }

# A request from inside the gateway's container: through the published port, the machine itself reaches the colony from
# Docker's own network, which MYRMO_ALLOWED_NETWORKS does not list (and should not).
inside() { local path="$1"; shift; compose exec -T gateway curl -s "$@" "http://127.0.0.1:8080$path"; }

setting() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }

# An operator request (the admin token never leaves this machine or appears in a process list: curl reads it from stdin).
admin() {
  local path="$1" token
  token=$(setting MYRMO_ADMIN_TOKEN)
  [ -n "$token" ] || { echo "No MYRMO_ADMIN_TOKEN in $ENV_FILE." >&2; return 1; }
  printf 'header = "Authorization: Bearer %s"\n' "$token" | compose exec -T gateway curl -s -K - "http://127.0.0.1:8080$path"
}

# The address people use: MYRMO_COLONY_URL from .env.private, else this machine's first address and the port.
colony_url() {
  local url
  url=$(setting MYRMO_COLONY_URL)
  [ -n "$url" ] || url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
  echo "$url"
}

# Settings added by later versions, written into an existing .env.private once, so `up` and `upgrade` bring an older
# colony to the current defaults without touching what the operator chose.
ensure_settings() {
  local added=""
  add() { grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >> "$ENV_FILE"; added="$added $1"; }; }
  add MYRMO_PRIVATE 1
  add MYRMO_TASK_EMBED_URL http://embed:80/task
  add EMBED_TASK_MODEL "$TASK_MODEL"
  add MYRMO_RECORD_GAPS 0
  # Data protection: the team is counted as a whole unless the organisation chose to name people (and told them).
  add MYRMO_PEOPLE_DETAIL aggregate
  # A share of error lookups answered with nothing, to measure what the colony saves (Value tab). 0: off.
  add MYRMO_HOLDOUT_PERCENT 0
  [ -z "$added" ] || echo "Added to $ENV_FILE:$added"
}

# What the colony counts about each person, in words for the invitation.
people_line() {
  if grep -q '^MYRMO_PEOPLE_DETAIL=named' "$ENV_FILE" 2>/dev/null; then
    echo "your searches, reports and publications, counted per day by name and kept 90 days"
  else
    echo "your searches, reports and publications only as team totals, never by name"
  fi
}

# The message to send a person: what the colony is, what they need, the one command, and how to check it worked.
invite() {
  local name="$1" key="$2" url
  url=$(colony_url)
  cat <<MSG

----- send this to $name, privately (the key is shown only now) -----
Hi $name,

We now have a shared memory for our coding agents. When you start a task, your agent is told what the team already
knows about it (procedures, which machine does what, errors that usually come up); when a command fails, it gets the
fix someone's agent already found; and what it learns is shared with the team. It runs on our own machine; nothing
goes to the internet. You need the team network.

You need: Node.js 20 or newer (node --version) and Claude Code and/or Antigravity.

1. Run this once (it sets up the agents on your machine):

   npx myrmo-mcp@latest init --url $url --key $key --private --publish auto

2. Restart Claude Code / Antigravity. In Antigravity, accept the permission for the myrmo tools ("always").
3. In Claude Code, let it update by itself: /plugin > Marketplaces > myrmo > Enable auto-update.
4. Check it:   npx myrmo-mcp@latest doctor     (it says what to fix, if anything)

The command is in your shell history with the key in it: delete that line (history -d) or edit it out. To keep the key out
of it, save this message to a file, delete the key line from your chat, and use --key-file <that file> instead of --key <key>
(it finds the key in the file).
What is shared: credentials, people's names, e-mails and customer data are removed; internal tool, service, machine and
network names are kept on purpose, because that is what the next agent needs. Tell the person who set this up if
something looks wrong or gets in the way.
What the colony keeps about you: your name and key, when it was last used and which Myrmo version you run (to manage
access); $(people_line); and, from Claude Code, what solving a problem cost (tokens, time, model; no text), kept only as
team totals (npx myrmo-mcp config effort off stops it). Ask the person who set this up to see or erase your data.
----------------------------------------------------------------------
MSG
}

wait_ready() {
  echo "Waiting for the colony (the first start loads the embedding models)..."
  for _ in $(seq 1 120); do inside /readyz >/dev/null 2>&1 && [ "$(inside /readyz -o /dev/null -w '%{http_code}')" = 200 ] && return 0; sleep 3; done
  return 1
}

show_stats() {
  admin /v1/admin/knowledge | python3 -c "$(cat <<'PY'
import json, sys
k = json.load(sys.stdin)
if "error" in k:
    sys.exit("The colony answered: " + k["error"].get("message", "error"))
kinds = k.get("kinds", {})
print("What the colony knows: %d entries (%d fixes, %d procedures, %d facts)" % (k.get("total", 0), kinds.get("fix", 0), kinds.get("procedure", 0), kinds.get("fact", 0)))
src = ", ".join("%d from %s" % (v, s) for s, v in sorted(k.get("sources", {}).items()))
print("Where it came from: " + (src or "nothing yet"))
asked, answered = k.get("task_searches_30d", 0), k.get("task_answered_30d", 0)
rate = ("%d%%" % (100 * answered // asked)) if asked else "no requests yet"
print("Tasks in the last 30 days: %d looked up, %d with an answer (%s)" % (asked, answered, rate))
for name, what in [("stale", "no success in 90 days"), ("contested", "fails more than it works"), ("unconfirmed", "nobody reported on it after 2 weeks"), ("most_used", "most confirmed")]:
    block = k.get(name, {})
    print("\n%s (%s): %d" % (name.replace("_", " ").capitalize(), what, block.get("count", 0)))
    for item in block.get("items", [])[:5]:
        o = item.get("outcomes", {})
        print("  [%s] %s  strength %s  worked %d failed %d  %s" % (item["kind"], item["label"][:70], item["strength"], o.get("worked", 0), o.get("failed", 0), item["trail_id"][:8]))
PY
)"
}

show_gaps() {
  admin /v1/admin/gaps | python3 -c "$(cat <<'PY'
import json, sys
g = json.load(sys.stdin)
if not g.get("enabled"):
    print("Recording of unanswered task requests is off. Turn it on in the admin panel (Knowledge) or with MYRMO_RECORD_GAPS=1 in .env.private and up.")
items = g.get("items", [])
print("%d task requests without an answer in the last %d days:" % (len(items), g.get("days", 30)))
for i in items[:50]:
    print("  %s  %-12s %s" % (i["at"][:16], i.get("who") or "-", i["text"][:110]))
PY
)"
}

case "${1:-}" in
  up)
    if [ ! -f "$ENV_FILE" ]; then
      if [ -z "${MYRMO_ALLOWED_NETWORKS:-}" ]; then
        echo "Say which network may connect, for example:" >&2
        echo "  MYRMO_ALLOWED_NETWORKS=10.20.0.0/24 bash deploy/private-colony.sh up" >&2
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
    ensure_settings
    # --build: the server image must be this checkout's, never an older one left on the machine.
    compose up -d --build --no-deps valkey qdrant embed gateway enricher
    wait_ready || echo "Not ready yet: see bash deploy/private-colony.sh logs" >&2
    "$0" status || true
    echo
    echo "Address for your team: $(colony_url)"
    echo "Admin panel: $(colony_url)/admin   (the operator token is MYRMO_ADMIN_TOKEN in $ENV_FILE)"
    echo "Next: one key per person:   bash deploy/private-colony.sh keys add <name>"
    crontab -l 2>/dev/null | grep -q "private-colony.sh backup" || echo "And a daily backup:         bash deploy/private-colony.sh backup schedule"
    ;;
  upgrade)
    if [ -d .git ] && [ "${MYRMO_NO_PULL:-0}" != 1 ]; then
      git pull --ff-only || { echo "git pull failed: resolve it (or run with MYRMO_NO_PULL=1 to rebuild this checkout as it is)." >&2; exit 1; }
    fi
    [ -f "$ENV_FILE" ] || { echo "No $ENV_FILE: run 'up' first." >&2; exit 1; }
    "$0" backup || echo "The backup before upgrading failed; continuing (the data stays in the Docker volumes)." >&2
    "$0" up
    ;;
  status)
    health=$(inside /readyz -o /dev/null -w '%{http_code}' || true)
    nokey=$(inside /v1/search -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d '{"query":"check without a key"}' || true)
    echo "ready: $health (200 expected)   a request without a key: $nokey (401 expected)"
    [ "$health" = 200 ] && [ "$nokey" = 401 ]
    ;;
  doctor)
    fail=0
    check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1  -> $3"; fail=1; fi; }
    check "settings file $ENV_FILE exists and only you can read it" "[ -f '$ENV_FILE' ] && [ \"\$(stat -c %a '$ENV_FILE')\" = 600 ]" "chmod 600 $ENV_FILE (or run up)"
    for svc in gateway enricher embed qdrant valkey; do
      check "$svc is running" "[ -n \"\$(compose ps -q --status running $svc)\" ]" "bash deploy/private-colony.sh up; then logs $svc"
    done
    check "the colony is ready" "[ \"\$(inside /readyz -o /dev/null -w '%{http_code}')\" = 200 ]" "bash deploy/private-colony.sh logs gateway"
    check "a request without a key is refused" "[ \"\$(inside /v1/search -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"query\":\"x\"}')\" = 401 ]" "set MYRMO_REQUIRE_KEY=1 in $ENV_FILE and run up"
    settings=$(admin /v1/admin/settings 2>/dev/null || true)
    check "organisation mode is on" "echo '$settings' | grep -q '\"private\":true'" "set MYRMO_PRIVATE=1 in $ENV_FILE and run up"
    check "the task index is on" "echo '$settings' | grep -q '\"task_index\":true'" "run up (it adds MYRMO_TASK_EMBED_URL and EMBED_TASK_MODEL)"
    check "a daily backup is scheduled" "crontab -l | grep -q 'private-colony.sh backup'" "bash deploy/private-colony.sh backup schedule"
    newest=$(ls -t "${MYRMO_BACKUP_DIR:-$HOME/myrmo-backups}"/*.tar.gz 2>/dev/null | head -n 1 || true)
    check "the newest backup is less than 2 days old" "[ -n '$newest' ] && [ \$(( \$(date +%s) - \$(stat -c %Y '$newest') )) -lt 172800 ]" "bash deploy/private-colony.sh backup"
    check "more than 2 GB free for Docker" "[ \$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print \$4}') -gt 2000000 ]" "free some disk space"
    exit $fail
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
  stats)
    show_stats
    ;;
  gaps)
    show_gaps
    ;;
  report)
    compose exec -T gateway myrmo-server team-report "${2:-7}"
    ;;
  backup)
    if [ "${2:-}" = schedule ]; then
      line="17 3 * * * cd $(pwd) && MYRMO_PROJECT=$PROJECT bash deploy/backup.sh >> \$HOME/myrmo-backups/backup.log 2>&1"
      mkdir -p "$HOME/myrmo-backups"
      (crontab -l 2>/dev/null | grep -v "deploy/backup.sh" | grep -v "private-colony.sh backup"; echo "$line # private-colony.sh backup") | crontab -
      echo "Scheduled: a backup every day at 03:17, two weeks kept in ~/myrmo-backups, readable by you only. Keep a copy on another machine too: deploy/pull-backups.sh (or .ps1), or an S3-compatible store (see deploy/backup.sh)."
    else
      MYRMO_PROJECT="$PROJECT" bash deploy/backup.sh
    fi
    ;;
  logs)
    compose logs --tail 100 -f "${2:-gateway}"
    ;;
  down)
    compose stop
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
