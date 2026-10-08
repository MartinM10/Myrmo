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
tar xzf "$ARCHIVE" -C "$work"
[ -s "$work/valkey.rdb" ] && [ -s "$work/qdrant.snapshot" ] || { echo "the archive is incomplete" >&2; exit 1; }
cat "$work/manifest.txt"
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
docker run -d --name "$tmp" -v "$volume:/data" -v "$work:/in:ro" --entrypoint sh "$image" -c \
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
compose up -d qdrant gateway
for _ in $(seq 1 60); do docker exec "$GATEWAY" curl -fsS http://qdrant:6333/readyz >/dev/null 2>&1 && break; sleep 1; done
# Uploaded through stdin: nothing is left behind in the container.
docker exec -i "$GATEWAY" curl -fsS -X POST "$QDRANT/upload?priority=snapshot" \
  -F "snapshot=@-;filename=restore.snapshot" < "$work/qdrant.snapshot" >/dev/null

echo "starting the colony"
compose up -d gateway enricher
echo "restored. Check: GET /v1/stats and /readyz"
