#!/usr/bin/env bash
# Hands a colony's backup archives to another machine over SSH, and nothing else. Install it as the forced command of
# the key that machine uses, one line in ~/.ssh/authorized_keys on the colony's host:
#
#   command="bash $HOME/myrmo/deploy/backup-serve.sh",restrict ssh-ed25519 AAAA... backups@home
#
# (write the real path instead of $HOME). With that key the other machine can only ask for:
#   list             the archive names, newest first
#   get <name>       that archive, on stdout
# It cannot open a shell, forward ports or read anything outside the backup folder. deploy/pull-backups.sh (Linux,
# macOS) and deploy/pull-backups.ps1 (Windows) are the other end.
set -euo pipefail

DIR="${MYRMO_BACKUP_DIR:-$HOME/myrmo-backups}"
NAME='^myrmo-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'

# Split the requested command into words, with no wildcard expansion of what the client sent.
set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
set +f
case "${1:-}" in
  list)
    cd "$DIR"
    ls -1t -- myrmo-*.tar.gz 2>/dev/null | grep -E "$NAME" || true
    ;;
  get)
    name="${2:-}"
    [[ "$name" =~ $NAME ]] && [ -f "$DIR/$name" ] || { echo "no such backup: $name" >&2; exit 1; }
    cat -- "$DIR/$name"
    # Recorded in the colony, so that its panel knows a copy left this machine. The compose project is MYRMO_PROJECT,
    # or the only Valkey container running here. A failure here does not fail the copy.
    valkey="${MYRMO_PROJECT:+$MYRMO_PROJECT-valkey-1}"
    if [ -z "$valkey" ]; then
      found="$(docker ps --format '{{.Names}}' --filter name=valkey-1 2>/dev/null || true)"
      [ "$(printf '%s\n' "$found" | grep -c .)" = 1 ] && valkey="$found"
    fi
    [ -z "$valkey" ] || docker exec "$valkey" valkey-cli HSET backup:last offsite_ts "$(date +%s)" >/dev/null 2>&1 || true
    ;;
  *)
    echo "this key can only run: list | get <myrmo-YYYYMMDDTHHMMSSZ.tar.gz>" >&2
    exit 2
    ;;
esac
