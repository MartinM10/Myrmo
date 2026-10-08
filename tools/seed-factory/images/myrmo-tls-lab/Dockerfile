# A lab for certificate problems: a company root CA, two HTTPS servers that it signed, and the usual clients
# (curl, git, Python requests, Node, Java). Nothing here is secret: the keys are made when the image is built.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git openssl python3 python3-requests python3-pip nodejs default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/lab /opt/corp-ca \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Corp Root CA" -keyout /opt/lab/root.key -out /opt/corp-ca/corp-root-ca.pem \
 && printf 'subjectAltName=DNS:intranet.example\n' > /opt/lab/san.cnf \
 && openssl req -newkey rsa:2048 -nodes -subj "/CN=intranet.example" -keyout /opt/lab/server.key -out /opt/lab/server.csr \
 && openssl x509 -req -in /opt/lab/server.csr -CA /opt/corp-ca/corp-root-ca.pem -CAkey /opt/lab/root.key -CAcreateserial -days 3650 -extfile /opt/lab/san.cnf -out /opt/lab/server.crt \
 && openssl req -newkey rsa:1024 -nodes -subj "/CN=intranet.example" -keyout /opt/lab/small.key -out /opt/lab/small.csr \
 && openssl x509 -req -in /opt/lab/small.csr -CA /opt/corp-ca/corp-root-ca.pem -CAkey /opt/lab/root.key -CAcreateserial -days 3650 -extfile /opt/lab/san.cnf -out /opt/lab/small.crt \
 && openssl pkcs12 -export -legacy -inkey /opt/lab/server.key -in /opt/lab/server.crt -name legacy -passout pass:changeit -out /opt/lab/legacy.p12 \
 && rm /opt/lab/root.key
COPY server.py start.sh /opt/lab/
RUN chmod +x /opt/lab/start.sh
