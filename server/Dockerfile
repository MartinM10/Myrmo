# Myrmo colony server. Build context: repository root (the server embeds protocol/).
FROM rust:1-bookworm AS build
WORKDIR /src/server
# Compile dependencies first so source changes do not rebuild them.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY protocol/ /src/protocol/
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/server/target/release/myrmo-server /usr/local/bin/myrmo-server
USER nobody
EXPOSE 8080
ENTRYPOINT ["myrmo-server"]
CMD ["serve"]
