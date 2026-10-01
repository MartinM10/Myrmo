#!/usr/bin/env bash
# Run cargo inside the Rust container with cached registry and target directories.
# Usage: server/dev.sh test | server/dev.sh build --release | server/dev.sh clippy
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -W 2>/dev/null || pwd)"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT:/src" \
  -v myrmo-cargo:/usr/local/cargo/registry \
  -v myrmo-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -w /src/server \
  rust:1-bookworm cargo "$@"
