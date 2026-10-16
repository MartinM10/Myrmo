# Myrmo colony server. Build context: repository root (the server embeds protocol/).
# Base images are pinned by digest (Dependabot proposes the updates); the build uses Cargo.lock as committed (--locked).
FROM rust:1-bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29 AS build
WORKDIR /src/server
# Compile dependencies first so source changes do not rebuild them.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release --locked && rm -rf src
COPY protocol/ /src/protocol/
COPY .release-please-manifest.json /src/.release-please-manifest.json
COPY server/src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/server/target/release/myrmo-server /usr/local/bin/myrmo-server
USER nobody
EXPOSE 8080
ENTRYPOINT ["myrmo-server"]
CMD ["serve"]
