#!/bin/sh
# Starts the decision model as the unprivileged user `laya` (deploy/laya.Dockerfile).
# The model volume of a colony created before the image had that user belongs to root: it is handed over once, by the
# only step that runs as root, and then the server drops its privileges for good.
set -eu
if [ "$(id -u)" = 0 ]; then
  [ "$(stat -c %u /models)" = "$(id -u laya)" ] || chown -R laya:laya /models
  exec setpriv --reuid=laya --regid=laya --init-groups env HOME=/home/laya "$@"
fi
exec "$@"
