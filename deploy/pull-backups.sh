#!/usr/bin/env bash
# Copy a colony's backups to this machine: the off-site copy, pulled over SSH from a host whose key for this machine
# can only run deploy/backup-serve.sh. Copies the archives it does not have yet, checks each one is a readable
# archive before keeping it, and deletes local copies older than MYRMO_PULL_KEEP_DAYS (default 60).
#
#   MYRMO_PULL_HOST=myrmo-backups bash deploy/pull-backups.sh       # an ssh host or alias (key and user in ~/.ssh/config)
#
# Hourly from cron: it only copies what is new, and a machine that is sometimes off catches up on its next run, as
# long as it runs at least once within the colony's own retention (14 days by default):
#   0 * * * * MYRMO_PULL_HOST=myrmo-backups bash $HOME/myrmo/deploy/pull-backups.sh >> $HOME/myrmo-backups-copy/pull.log 2>&1
set -euo pipefail

HOST="${MYRMO_PULL_HOST:?set MYRMO_PULL_HOST to the colony host (an ssh host or alias)}"
DEST="${MYRMO_PULL_DIR:-$HOME/myrmo-backups-copy}"
KEEP_DAYS="${MYRMO_PULL_KEEP_DAYS:-60}"
NAME='^myrmo-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'

mkdir -p "$DEST"
chmod 700 "$DEST"
names="$(ssh -o BatchMode=yes "$HOST" list)"
copied=0
for name in $names; do
  [[ "$name" =~ $NAME ]] || continue
  [ -f "$DEST/$name" ] && continue
  ssh -o BatchMode=yes "$HOST" get "$name" > "$DEST/$name.partial"
  if tar tzf "$DEST/$name.partial" >/dev/null 2>&1; then
    mv "$DEST/$name.partial" "$DEST/$name"
    copied=$((copied + 1))
  else
    rm -f "$DEST/$name.partial"
    echo "$(date -u +%FT%TZ) WARNING: $name arrived damaged; it will be tried again next run" >&2
  fi
done
find "$DEST" -maxdepth 1 -name 'myrmo-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) copied $copied new archive(s); $(find "$DEST" -maxdepth 1 -name 'myrmo-*.tar.gz' | wc -l | tr -d ' ') kept in $DEST"
