FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates openssl python3 \
 && rm -rf /var/lib/apt/lists/*
# A "corporate" root CA, a server certificate it signed, and a server that uses it. The CA file is where IT left it.
RUN mkdir -p /opt/corp-ca /opt/intranet \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Corp Root CA" \
      -keyout /opt/corp-ca/root.key -out /opt/corp-ca/corp-root-ca.pem \
 && openssl req -newkey rsa:2048 -nodes -subj "/CN=intranet.example" \
      -keyout /opt/intranet/server.key -out /opt/intranet/server.csr \
 && printf 'subjectAltName=DNS:intranet.example\n' > /opt/intranet/san.cnf \
 && openssl x509 -req -in /opt/intranet/server.csr -CA /opt/corp-ca/corp-root-ca.pem -CAkey /opt/corp-ca/root.key \
      -CAcreateserial -days 3650 -extfile /opt/intranet/san.cnf -out /opt/intranet/server.crt \
 && rm /opt/corp-ca/root.key
COPY server.py /opt/intranet/server.py
COPY start.sh /usr/local/bin/start.sh
WORKDIR /work
COPY files/ /work/
RUN chmod +x /work/fetch.sh /usr/local/bin/start.sh
CMD ["/usr/local/bin/start.sh"]
