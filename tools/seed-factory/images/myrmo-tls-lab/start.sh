#!/bin/sh
# Names the intranet host and starts the two servers: 8443 with a 2048-bit certificate, 8444 with a 1024-bit one.
grep -q intranet.example /etc/hosts || echo "127.0.0.1 intranet.example" >> /etc/hosts
python3 /opt/lab/server.py 8443 /opt/lab/server.crt /opt/lab/server.key &
python3 /opt/lab/server.py 8444 /opt/lab/small.crt /opt/lab/small.key &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  python3 -c 'import socket; [socket.create_connection(("127.0.0.1", p), 1) for p in (8443, 8444)]' 2>/dev/null && break
  sleep 0.5
done
