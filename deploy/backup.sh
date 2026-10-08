#!/usr/bin/env bash
# Back up everything a colony knows: Qdrant (the trails and their vectors) and Valkey (outcomes,
# fingerprints, the feed, drafts). One archive per run, the newest N kept.
#
#   bash deploy/backup.sh                 # from the directory of the compose project
#   MYRMO_BACKUP_DIR=/mnt/backups MYRMO_BACKUP_KEEP=30 bash deploy/backup.sh
#
# Off-site copy: set MYRMO_BACKUP_S3_URI (for example s3://my-bucket/myrmo) and the archive is uploaded after it is
# written, with the AWS CLI. Any S3-compatible store works (Backblaze B2, Cloudflare R2, MinIO, Hetzner): also set
# MYRMO_BACKUP_S3_ENDPOINT to its address. Credentials come from the usual environment variables or profile
# (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION); they are never written anywhere by this script.
# A failed upload is reported and the local archive stays; set MYRMO_BACKUP_S3_REQUIRED=1 to make it fail the run.
# Put these variables in ~/.myrmo-backup.env (chmod 600) and this script reads them itself, from cron or from a deploy.
# Old remote archives are not deleted here: use the bucket's lifecycle rules.
#
# Restore with deploy/restore.sh. Run it from cron, for example daily:
#   17 3 * * * cd $HOME/myrmo && bash deploy/backup.sh >> $HOME/myrmo-backups/backup.log 2>&1
set -euo pipefail

# Settings for the off-site copy can live in a file only you can read, so that cron and the deploy script both see them.
[ -f "$HOME/.myrmo-backup.env" ] && . "$HOME/.myrmo-backup.env"

PROJECT="${MYRMO_PROJECT:-myrmo}"            # the compose project name (the container name prefix)
DIR="${MYRMO_BACKUP_DIR:-$HOME/myrmo-backups}"
KEEP="${MYRMO_BACKUP_KEEP:-14}"
COLLECTION="${MYRMO_COLLECTION:-trails}"
VALKEY="${PROJECT}-valkey-1"
GATEWAY="${PROJECT}-gateway-1"                 # any container on the network with curl
QDRANT="http://qdrant:6333/collections/${COLLECTION}/snapshots"

mkdir -p "$DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

echo "$(date -u +%FT%TZ) backup start"

# Valkey: a consistent RDB snapshot taken through the replication protocol.
docker exec "$VALKEY" valkey-cli --rdb /tmp/myrmo-backup.rdb >/dev/null 2>&1
docker cp "$VALKEY:/tmp/myrmo-backup.rdb" "$work/valkey.rdb"
docker exec "$VALKEY" rm -f /tmp/myrmo-backup.rdb
trails="$(docker exec "$VALKEY" valkey-cli get stats:trails || true)"

# Qdrant: a snapshot, downloaded; the ones left on the server are removed afterwards.
name="$(docker exec "$GATEWAY" curl -fsS -X POST "$QDRANT" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
[ -n "$name" ] || { echo "qdrant did not create a snapshot" >&2; exit 1; }
docker exec "$GATEWAY" curl -fsS "$QDRANT/$name" > "$work/qdrant.snapshot"
for old in $(docker exec "$GATEWAY" curl -fsS "$QDRANT" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
  [ "$old" = "$name" ] || docker exec "$GATEWAY" curl -fsS -X DELETE "$QDRANT/$old" >/dev/null
done

[ -s "$work/valkey.rdb" ] && [ -s "$work/qdrant.snapshot" ] || { echo "a backup file is empty" >&2; exit 1; }
printf 'created=%s\nproject=%s\ncollection=%s\ntrails=%s\nqdrant_snapshot=%s\n' \
  "$stamp" "$PROJECT" "$COLLECTION" "${trails:-0}" "$name" > "$work/manifest.txt"

archive="$DIR/myrmo-$stamp.tar.gz"
tar czf "$archive.partial" -C "$work" manifest.txt valkey.rdb qdrant.snapshot
tar tzf "$archive.partial" >/dev/null          # the archive must be readable before it counts
mv "$archive.partial" "$archive"

# Keep the newest $KEEP.
ls -1t "$DIR"/myrmo-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

if [ -n "${MYRMO_BACKUP_S3_URI:-}" ]; then
  if command -v aws >/dev/null 2>&1 \
    && aws ${MYRMO_BACKUP_S3_ENDPOINT:+--endpoint-url "$MYRMO_BACKUP_S3_ENDPOINT"} s3 cp "$archive" \
         "${MYRMO_BACKUP_S3_URI%/}/$(basename "$archive")" --only-show-errors; then
    echo "$(date -u +%FT%TZ) uploaded to ${MYRMO_BACKUP_S3_URI%/}/$(basename "$archive")"
  else
    echo "$(date -u +%FT%TZ) WARNING: the off-site copy failed (is the aws CLI installed, and are the credentials set?)" >&2
    [ "${MYRMO_BACKUP_S3_REQUIRED:-0}" != "1" ] || exit 1
  fi
fi

echo "$(date -u +%FT%TZ) backup done: $archive ($(du -h "$archive" | cut -f1), ${trails:-0} trails)"
