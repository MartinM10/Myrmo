#!/bin/sh
# Start the private index, wait until it answers (with 401: it wants credentials), then idle.
python3 /opt/acme/bin/index_server.py &
until python3 -c "
import sys, urllib.request, urllib.error
try:
    urllib.request.urlopen('http://127.0.0.1:8081/simple/', timeout=2)
except urllib.error.HTTPError as e:
    sys.exit(0 if e.code == 401 else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; do sleep 0.3; done
touch /tmp/index.ready
exec sleep infinity
