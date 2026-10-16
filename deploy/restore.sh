#!/usr/bin/env bash
# Restore a colony from an archive made by deploy/backup.sh. This REPLACES what the colony holds.
#
#   bash deploy/restore.sh ~/myrmo-backups/myrmo-20261002T031700Z.tar.gz
#   bash deploy/restore.sh s3://my-bucket/myrmo/myrmo-20261002T031700Z.tar.gz     # from the off-site copy
#                                    (MYRMO_BACKUP_S3_ENDPOINT and the AWS credentials as in backup.sh)
#
# Run it from the directory of the compose project. It stops the gateway and the enrichers, puts
# the data back and starts them again. Set MYRMO_COMPOSE to the compose files in use, for example
#   MYRMO_COMPOSE="-f docker-compose.yml -f deploy/docker-compose.prod.yml"
set -euo pipefail

ARCHIVE="${1:?usage: restore.sh <backup.tar.gz>}"
PROJECT="${MYRMO_PROJECT:-myrmo}"
COMPOSE_FILES="${MYRMO_COMPOSE:-}"
COLLECTION="${MYRMO_COLLECTION:-trails}"
compose() { docker compose -p "$PROJECT" $COMPOSE_FILES "$@"; }
GATEWAY="${PROJECT}-gateway-1"
QDRANT="http://qdrant:6333/collections/${COLLECTION}/snapshots"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
case "$ARCHIVE" in
  s3://*)
    command -v aws >/dev/null || { echo "the aws CLI is needed to read $ARCHIVE" >&2; exit 1; }
    aws ${MYRMO_BACKUP_S3_ENDPOINT:+--endpoint-url "$MYRMO_BACKUP_S3_ENDPOINT"} s3 cp "$ARCHIVE" "$work/archive.tar.gz" --only-show-errors
    ARCHIVE="$work/archive.tar.gz"
    ;;
esac
[ -f "$ARCHIVE" ] || { echo "no such file: $ARCHIVE" >&2; exit 1; }

# Only the files backup.sh writes are taken out of the archive, into an empty directory, and each must be a plain file:
# a link in a crafted archive would otherwise make this script read another file of this machine (its .env, say) and
# send it to Qdrant or Valkey.
data="$work/data"
mkdir "$data"
members="manifest.txt valkey.rdb qdrant.snapshot"
listing="$(tar tzf "$ARCHIVE")" || { echo "not a readable archive: $ARCHIVE" >&2; exit 1; }
grep -qx 'SHA256SUMS' <<< "$listing" && members="$members SHA256SUMS"
for name in $members; do
  grep -qxF "$name" <<< "$listing" || { echo "the archive is incomplete: no $name" >&2; exit 1; }
done
# shellcheck disable=SC2086 # the member names are the fixed words above
tar xzf "$ARCHIVE" -C "$data" --no-same-owner --no-same-permissions $members
for name in $members; do
  [ -f "$data/$name" ] && [ ! -L "$data/$name" ] || { echo "the archive's $name is not a plain file: refusing it" >&2; exit 1; }
done
[ -s "$data/valkey.rdb" ] && [ -s "$data/qdrant.snapshot" ] || { echo "the archive is incomplete" >&2; exit 1; }

# The checksums written by backup.sh detect a copy that was cut short or damaged (they do not prove who made it).
if [ -f "$data/SHA256SUMS" ]; then
  for name in manifest.txt valkey.rdb qdrant.snapshot; do
    want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$data/SHA256SUMS")"
    have="$(sha256sum < "$data/$name" | cut -d' ' -f1)"
    [ -n "$want" ] && [ "$want" = "$have" ] || { echo "$name does not match its checksum: the archive is damaged" >&2; exit 1; }
  done
  echo "checksums match"
else
  echo "WARNING: this archive has no checksums (made before they were added): it cannot be checked for damage" >&2
fi

# Printed without control characters, so the manifest cannot rewrite the terminal.
LC_ALL=C tr -cd '\11\12\40-\176' < "$data/manifest.txt" | head -n 20
echo "This replaces the data of project '$PROJECT'. Continue? [y/N]"
read -r answer
[ "$answer" = "y" ] || { echo "cancelled"; exit 1; }

echo "stopping the gateway and the enrichers"
compose stop gateway enricher

echo "restoring Valkey"
compose stop valkey
volume="${PROJECT}_valkey-data"
image="$(compose config --images | grep -i valkey | head -1)"
# A server started with the append-only file on ignores an RDB when there is no AOF, so load the
# RDB in a temporary server with it off, then switch the AOF on and let it write itself from memory.
tmp="${PROJECT}-restore-valkey"
docker rm -f "$tmp" >/dev/null 2>&1 || true
docker run -d --name "$tmp" -v "$volume:/data" -v "$data:/in:ro" --entrypoint sh "$image" -c \
  'rm -rf /data/appendonlydir && cp /in/valkey.rdb /data/dump.rdb && exec valkey-server --dir /data --dbfilename dump.rdb --appendonly no --save ""' >/dev/null
for _ in $(seq 1 30); do docker exec "$tmp" valkey-cli ping >/dev/null 2>&1 && break; sleep 1; done
docker exec "$tmp" valkey-cli config set appendonly yes >/dev/null
for _ in $(seq 1 60); do
  docker exec "$tmp" valkey-cli info persistence | tr -d '\r' | grep -q '^aof_rewrite_in_progress:0$' && break
  sleep 1
done
docker exec "$tmp" valkey-cli shutdown nosave >/dev/null 2>&1 || true
docker wait "$tmp" >/dev/null 2>&1 || true
docker rm -f "$tmp" >/dev/null 2>&1 || true
docker run --rm -v "$volume:/data" --entrypoint sh "$image" -c 'rm -f /data/dump.rdb; chown -R valkey:valkey /data'
compose up -d valkey
for _ in $(seq 1 30); do docker exec "${PROJECT}-valkey-1" valkey-cli ping >/dev/null 2>&1 && break; sleep 1; done
echo "valkey holds $(docker exec "${PROJECT}-valkey-1" valkey-cli dbsize) keys"

echo "restoring Qdrant"
compose up -d --no-deps qdrant gateway
for _ in $(seq 1 60); do docker exec "$GATEWAY" curl -fsS http://qdrant:6333/readyz >/dev/null 2>&1 && break; sleep 1; done
# Uploaded through stdin: nothing is left behind in the container.
docker exec -i "$GATEWAY" curl -fsS -X POST "$QDRANT/upload?priority=snapshot" \
  -F "snapshot=@-;filename=restore.snapshot" < "$data/qdrant.snapshot" >/dev/null

echo "starting the colony"
compose up -d --no-deps gateway enricher
echo "restored. Check: GET /v1/stats and /readyz"
