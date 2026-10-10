# The Antigravity CLI (agy) for Linux, for MyrmoBench. Its binary is copied into each task's agent image; this image is
# also where a person signs in once (see docs/operate/benchmarks.md), into the myrmobench-agy volume.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- -d /usr/local/bin \
 && test -x /usr/local/bin/agy \
 && rm -rf /root/.local
# Without a browser or a keyring, agy prints a sign-in link and takes the pasted reply, as over SSH.
ENV SSH_CONNECTION=myrmobench
CMD ["agy"]
