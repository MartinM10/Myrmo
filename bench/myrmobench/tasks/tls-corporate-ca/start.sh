#!/bin/sh
grep -q intranet.example /etc/hosts || echo "127.0.0.1 intranet.example" >> /etc/hosts
python3 /opt/intranet/server.py &
exec sleep infinity
