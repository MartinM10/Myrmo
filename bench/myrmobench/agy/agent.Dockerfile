# A task image plus the Antigravity CLI. The agy binary comes from the myrmobench/agy image (agy/Dockerfile), which
# run.py builds first; the sign-in is not in the image, it is copied from the myrmobench-agy volume into each container.
ARG BASE
FROM ${BASE}
RUN command -v node >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*)
COPY --from=myrmobench/agy /usr/local/bin/agy /usr/local/bin/agy
# agy verifies TLS with the system's root certificates, and some task images have none (node:*-slim relies on Node's own
# bundle). Those get the standard bundle at its standard path; an image that has a store keeps it untouched, since a
# task's certificate store can be part of its breakage, and no variable such as SSL_CERT_FILE is set for the same reason.
COPY --from=myrmobench/agy /etc/ssl/certs/ca-certificates.crt /tmp/agy-ca-certificates.crt
RUN if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then \
      mkdir -p /etc/ssl/certs && cp /tmp/agy-ca-certificates.crt /etc/ssl/certs/ca-certificates.crt; \
    fi; rm -f /tmp/agy-ca-certificates.crt
# Without a browser or a keyring, agy behaves as over SSH and never tries to open one.
ENV SSH_CONNECTION=myrmobench
