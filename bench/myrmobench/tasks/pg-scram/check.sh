#!/bin/sh
cd /work || { echo "FAIL: /work is gone"; exit 1; }
sha256sum -c /opt/pg_hba.sha256 >/dev/null 2>&1 || { echo "FAIL: pg_hba.conf was changed"; exit 1; }
su postgres -c "psql -qAt -c \"select rolpassword like 'SCRAM-SHA-256%' from pg_authid where rolname='postgres'\"" | grep -q '^t$' \
  || { echo "FAIL: the password is no longer stored as SCRAM"; exit 1; }
grep -q 'pg8000' app.py || { echo "FAIL: app.py no longer uses pg8000"; exit 1; }
out="$(python app.py 2>&1)" || { echo "FAIL: python app.py exits non-zero: $(echo "$out" | tail -n 1)"; exit 1; }
echo "$out" | grep -q '^DB OK 42$' || { echo "FAIL: not DB OK 42"; exit 1; }
echo PASS
