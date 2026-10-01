#!/usr/bin/env bash
# Run cargo inside the Rust container with cached registry, toolchain components and target.
# Usage: server/dev.sh test | server/dev.sh fmt | server/dev.sh clippy --all-targets -- -D warnings
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -W 2>/dev/null || pwd)"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT:/src" \
  -v myrmo-cargo:/usr/local/cargo/registry \
  -v myrmo-rustup:/usr/local/rustup \
  -v myrmo-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -w /src/server \
  rust:1-bookworm bash -c 'rustup component add rustfmt clippy >/dev/null 2>&1; cargo "$@"' cargo "$@"
