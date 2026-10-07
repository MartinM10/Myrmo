---
title: "Development: build, test and release"
description: "How the Myrmo repository is laid out, the exact commands that CI runs for each part, how to run the benchmarks, and how commits, merges and releases work."
---

# Development

One repository holds everything. This page is the map and the list of commands; [CONTRIBUTING](https://github.com/MartinM10/Myrmo/blob/main/CONTRIBUTING.md)
has the sign-off and licence rules.

## Layout

| Folder | What | Language |
|---|---|---|
| `server/` | The colony: gateway, enricher, fingerprints, relevance, redaction, risk rules | Rust |
| `clients/typescript/` | `myrmo` (SDK) and `myrmo-mcp` (MCP server), one npm workspace | TypeScript |
| `clients/python/` | The Python SDK | Python |
| `plugins/myrmo/` | The Claude Code plugin: hook, skill, launcher | JavaScript |
| `protocol/` | Trail schema, fingerprint references and vectors, redaction vectors, examples | JSON, Python |
| `tools/seed-factory/` | Trails made from commands run in containers | Python |
| `bench/` | Load, retrieval, scale and leak benchmarks, and their results | Python, JavaScript |
| `web/`, `docs/` | The website and these docs (VitePress) | HTML, Markdown |
| `deploy/` | Production compose file, nginx, the deploy script, backups | Shell, YAML |

## Run the tests

These are the commands CI runs; run the ones for the part you changed.

| Part | Command | Notes |
|---|---|---|
| Server | `cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | No Rust toolchain? `docker run --rm -v "$PWD:/src" -w /src/server rust:1-bookworm cargo test` |
| JavaScript SDK and MCP server | `cd clients/typescript && npm ci && npm run build && npm test` | Then `node scripts/check-sdk-floor.mjs`: starts the built server with the lowest SDK it accepts |
| Python SDK | `cd clients/python && pip install -e ".[test]" && pytest -q` | CI runs Python 3.9 and 3.13 |
| Plugin | `node --test "plugins/myrmo/test/*.test.mjs"` | |
| Protocol | `python protocol/fingerprint_v1.py && python protocol/fingerprint_v2.py` | Each reference checks its own vectors; the Rust server and both SDKs check the same vectors in their tests |
| Seed factory | `pip install pytest jsonschema && python -m pytest tools/seed-factory -q` | No Docker needed |
| Docs | `cd docs && npm ci && npm run build` | Then `node scripts/llms.mjs --check`: `web/llms.txt` must list every page (`--write` updates it) |
| End to end | `docker compose up -d --build --no-deps valkey qdrant embed gateway enricher`, then `python3 server/tests/smoke.py http://localhost:8080` | Set `MYRMO_ADMIN_TOKEN` on both to also test the operator endpoints, and `MYRMO_DECISION_URL=""` to skip the 1.7 GB decision model |

Two things that save an afternoon:

- The vectors are the contract. A change to a fingerprint or a redaction rule changes the reference **and** its vectors file
  **and** every implementation, and CI fails if one of them disagrees.
- The smoke test publishes real trails and removes them afterwards when it has the operator token. Run it against a
  local colony, never production.

## Benchmarks

Each suite has its own section in [Benchmarks](./benchmarks.md) with the command and what it measures. They all need a
local colony; none may run against production, because they publish.

| Suite | One line |
|---|---|
| `bench/retrieval/run.py` | Does a search find the right trail, and stay quiet when there is none. About a minute, no GPU |
| `bench/fingerprint/compare.py` | How often the exact lookup finds a repeat error |
| `bench/load/` | k6 load test of each path of one colony node |
| `bench/scale/` | Up to a million varied trails: throughput, needles and strangers, keys that gather many trails |
| `bench/leaks/run.py` | How much sensitive data gets through |

## Commits, merges and releases

- **Conventional Commits** (`feat(scope):`, `fix(scope):`, `docs:`, `test:`, `ci:`...) drive the versions and the changelogs;
  the scope names the component. Sign off each commit with `git commit -s`.
- **Merge with rebase or squash, not with a merge commit.** A merge commit makes release-please read the branch commit and
  the merge commit as two changes, and every entry of the changelog appears twice. Rebase keeps one commit per component.
- **release-please** keeps a pull request open with the next version of every component that changed. Merging it tags and
  publishes: `myrmo` and `myrmo-mcp` to npm, the Python SDK to PyPI, the server image to GHCR, the rest as GitHub releases.
  A publication cannot be taken back, so that merge is a decision, not a chore.
- **Every merge to `main` deploys.** CI runs on `main`, and when it passes the deploy workflow ships the commit to
  production (see [Automatic deployment](./deployment.md)). A change to the server therefore reaches users when it is
  merged, whether or not a release follows.

## A change that touches the server

1. Change the code and its unit tests; run `cargo fmt`, `clippy` and `cargo test`.
2. If it changes what the API answers, add a check to `server/tests/smoke.py`.
3. If it could change speed or the quality of search, run the scale suite before and after (the same haystack and seed make
   the numbers comparable) and put both in the pull request.
4. Document it where a user would look for it: the [API](../reference/api.md), [Configuration](../reference/configuration.md) or
   [Privacy](../security/privacy.md) page, and the roadmap if it leaves a known limit.
