# A task image plus the Antigravity CLI. The agy binary comes from the myrmobench/agy image (agy/Dockerfile), which
# run.py builds first; the sign-in is not in the image, it is copied from the myrmobench-agy volume into each container.
ARG BASE
FROM ${BASE}
RUN command -v node >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*)
COPY --from=myrmobench/agy /usr/local/bin/agy /usr/local/bin/agy
# Without a browser or a keyring, agy behaves as over SSH and never tries to open one.
ENV SSH_CONNECTION=myrmobench
