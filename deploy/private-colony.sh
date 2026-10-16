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
# nothing is sent to any outside service. MYRMO_PORT changes the port (default 8080), MYRMO_HOST_IP the address it
# listens on (default 0.0.0.0, every interface; give one interface's address to serve only that network). Only the
# networks in MYRMO_ALLOWED_NETWORKS may connect (the first `up` asks for them; `any` opens it). MYRMO_COLONY_URL is the
# address people use (default http://<this machine's first address>:<port>). Over plain HTTP, `up` refuses networks
# beyond the private ranges (or `any`) unless MYRMO_ACCEPT_PLAIN_HTTP=1 says you know keys would cross them in clear:
# put a reverse proxy with TLS in front instead (docs/operate/self-hosting.md). Each person then sets up their machine
# with the message `keys add` prints. Most settings can also be changed from the admin panel while the colony runs.
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
  # The compose file listens on 127.0.0.1 only unless told otherwise; a private colony serves its team's network.
  add MYRMO_HOST_IP 0.0.0.0
  # No reverse proxy stands in front of a private colony: no address may claim to speak for another (X-Forwarded-For).
  add MYRMO_TRUSTED_PROXIES ""
  [ -z "$added" ] || echo "Added to $ENV_FILE:$added"
}

# True when every range in the comma-separated list is inside a private, loopback, link-local or shared (CGNAT, as
# Tailscale uses) range, and no broader than it. Anything else, an empty list (everyone) included, is not private.
private_ranges() {
  local list="$1" entry entries addr prefix a b
  [ -n "$list" ] || return 1
  IFS=',' read -ra entries <<< "$list"
  for entry in "${entries[@]}"; do
    entry="${entry//[[:space:]]/}"
    [ -n "$entry" ] || continue
    addr="${entry%%/*}"
    if [[ "$entry" == */* ]]; then prefix="${entry#*/}"; else prefix=128; [[ "$addr" == *:* ]] || prefix=32; fi
    [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
    if [[ "$addr" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
      a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"
      if [ "$a" = 10 ] && [ "$prefix" -ge 8 ]; then continue; fi
      if [ "$a" = 127 ] && [ "$prefix" -ge 8 ]; then continue; fi
      if [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && [ "$prefix" -ge 12 ]; then continue; fi
      if [ "$a" = 192 ] && [ "$b" = 168 ] && [ "$prefix" -ge 16 ]; then continue; fi
      if [ "$a" = 169 ] && [ "$b" = 254 ] && [ "$prefix" -ge 16 ]; then continue; fi
      if [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && [ "$prefix" -ge 10 ]; then continue; fi
      return 1
    fi
    addr="${addr,,}"
    if [ "$addr" = ::1 ]; then continue; fi
    if [[ "$addr" =~ ^f[cd][0-9a-f]{0,2}: ]] && [ "$prefix" -ge 7 ]; then continue; fi
    if [[ "$addr" =~ ^fe[89ab][0-9a-f]?: ]] && [ "$prefix" -ge 10 ]; then continue; fi
    return 1
  done
}

# Keys and the operator token travel with every request. Over plain HTTP they must not cross networks you do not
# control, so the colony must either be limited to private ranges or be served over HTTPS (a reverse proxy with TLS).
in_clear_beyond_private() {
  local url
  url=$(colony_url)
  [[ "$url" != https://* ]] && ! private_ranges "$(setting MYRMO_ALLOWED_NETWORKS)"
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
MYRMO_HOST_IP=${MYRMO_HOST_IP:-0.0.0.0}
MYRMO_ADMIN_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
MYRMO_SALT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
EOF
      echo "Created $ENV_FILE (keys required, no external decision service)."
    fi
    ensure_settings
    if in_clear_beyond_private; then
      networks=$(setting MYRMO_ALLOWED_NETWORKS)
      {
        echo
        echo "WARNING: this colony is served over plain HTTP ($(colony_url)) and accepts connections from ${networks:-any network}."
        echo "Every request carries a person's key, and the admin panel the operator token, in clear: anyone on the way"
        echo "(a public Wi-Fi, a provider, the internet) can read them and use the colony as that person or as you."
        echo "Either limit MYRMO_ALLOWED_NETWORKS in $ENV_FILE to your private networks (10.x, 172.16-31.x, 192.168.x, a VPN),"
        echo "or put a reverse proxy with TLS in front and set MYRMO_COLONY_URL=https://... (docs/operate/self-hosting.md)."
      } >&2
      if [ "${MYRMO_ACCEPT_PLAIN_HTTP:-}" = 1 ] || [ "$(setting MYRMO_ACCEPT_PLAIN_HTTP)" = 1 ]; then
        grep -q '^MYRMO_ACCEPT_PLAIN_HTTP=1$' "$ENV_FILE" || echo "MYRMO_ACCEPT_PLAIN_HTTP=1" >> "$ENV_FILE"
        echo "Going on: MYRMO_ACCEPT_PLAIN_HTTP=1 (kept in $ENV_FILE; remove that line to be asked again)." >&2
      else
        echo "To go on anyway, knowing this: MYRMO_ACCEPT_PLAIN_HTTP=1 bash deploy/private-colony.sh up" >&2
        exit 2
      fi
    fi
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
    # check <what> <what to do if it fails> <command> [args...]: the command runs as given, never through eval, so
    # nothing the colony answers (the settings can be edited in the admin panel) or a file name can become shell code.
    check() {
      local what="$1" fix="$2"; shift 2
      if "$@" >/dev/null 2>&1; then echo "ok    $what"; else echo "FAIL  $what  -> $fix"; fail=1; fi
    }
    private_file() { [ -f "$ENV_FILE" ] && [ "$(stat -c %a "$ENV_FILE")" = 600 ]; }
    running() { [ -n "$(compose ps -q --status running "$1")" ]; }
    ready() { [ "$(inside /readyz -o /dev/null -w '%{http_code}')" = 200 ]; }
    refuses_without_key() {
      [ "$(inside /v1/search -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"query":"x"}')" = 401 ]
    }
    settings=$(admin /v1/admin/settings 2>/dev/null || true)
    setting_on() { printf '%s' "$settings" | grep -qF -- "\"$1\":true"; }
    backup_scheduled() { crontab -l 2>/dev/null | grep -q 'private-colony.sh backup'; }
    newest=$(ls -t "${MYRMO_BACKUP_DIR:-$HOME/myrmo-backups}"/*.tar.gz 2>/dev/null | head -n 1 || true)
    backup_recent() { [ -n "$newest" ] && [ $(( $(date +%s) - $(stat -c %Y "$newest") )) -lt 172800 ]; }
    disk_free() { [ "$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')" -gt 2000000 ]; }
    not_in_clear() { ! in_clear_beyond_private; }
    check "settings file $ENV_FILE exists and only you can read it" "chmod 600 $ENV_FILE (or run up)" private_file
    for svc in gateway enricher embed qdrant valkey; do
      check "$svc is running" "bash deploy/private-colony.sh up; then logs $svc" running "$svc"
    done
    check "the colony is ready" "bash deploy/private-colony.sh logs gateway" ready
    check "a request without a key is refused" "set MYRMO_REQUIRE_KEY=1 in $ENV_FILE and run up" refuses_without_key
    check "organisation mode is on" "set MYRMO_PRIVATE=1 in $ENV_FILE and run up" setting_on private
    check "the task index is on" "run up (it adds MYRMO_TASK_EMBED_URL and EMBED_TASK_MODEL)" setting_on task_index
    check "keys do not cross other networks in clear" \
      "limit MYRMO_ALLOWED_NETWORKS to private ranges, or serve it over HTTPS (docs/operate/self-hosting.md)" not_in_clear
    check "a daily backup is scheduled" "bash deploy/private-colony.sh backup schedule" backup_scheduled
    check "the newest backup is less than 2 days old" "bash deploy/private-colony.sh backup" backup_recent
    check "more than 2 GB free for Docker" "free some disk space" disk_free
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
      # Quoted for the shell cron runs, and with % escaped, which cron would otherwise turn into a new line.
      dir=$(printf '%q' "$PWD"); project=$(printf '%q' "$PROJECT")
      line="17 3 * * * cd ${dir//%/\\%} && MYRMO_PROJECT=${project//%/\\%} bash deploy/backup.sh >> \$HOME/myrmo-backups/backup.log 2>&1"
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
