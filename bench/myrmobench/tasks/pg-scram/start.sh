#!/bin/sh
pg_ctlcluster 16 main start
until su postgres -c "psql -qAt -c 'select 1'" >/dev/null 2>&1; do sleep 0.5; done
su postgres -c "psql -q -c \"ALTER USER postgres PASSWORD 'bench-secret'\""
sha256sum /etc/postgresql/16/main/pg_hba.conf > /opt/pg_hba.sha256
exec sleep infinity
