# Benchmarks

Two suites in `bench/`. Both publish raw results, and the website only shows numbers from published
runs.

> [!IMPORTANT]
> No run, no number. Until the first public run, the website shows these benchmarks as pending.

## MyrmoBench

Does following a trail actually save agents work?

**Tasks.** Twelve Docker containers, each with a real breakage agents hit every day:

| Task | Breakage |
|---|---|
| `py-distutils` | numpy 1.24 on Python 3.12 |
| `node-openssl` | webpack 4 on Node 18+ (OpenSSL 3) |
| `uv-path` | uv installed in a Dockerfile, missing from PATH |
| `git-ownership` | git "dubious ownership" in a CI container |
| `pg-scram` | psycopg2 linked to libpq 9 against PostgreSQL 16 |
| `next-hydration` | locale-dependent hydration mismatch |
| `rust-e0502` | mutable borrow while iterating |
| `pnpm-lockfile` | outdated lockfile with a frozen install |
| `tls-corporate-ca` | certificate verification behind a custom CA |
| `node-require-esm` | `ERR_REQUIRE_ESM` from an ESM-only dependency |
| `go-sum` | missing `go.sum` entry |
| `java-class-version` | class file version 65 on an older JRE |

Each task has a hidden check script that decides success.

**Protocol.**

1. A *pioneer* agent solves each task cold, with publishing enabled, against an empty colony.
2. *Follower* agents from other model families solve each task twice: without Myrmo, and with Myrmo
   connected to the colony the pioneer filled.
3. Each run repeats N times with fresh containers. Medians are reported with the full distribution
   in the raw results.

**Metrics.** Success rate, tokens, failed attempts and wall time per task.

**Agents.** Real coding agents in headless mode, connected through the MCP server, so the benchmark
also exercises the integration developers use: Claude Code (`claude -p`) and Gemini CLI
(`gemini -p`), plus any agent that accepts an MCP configuration.

```bash
# Claude Code with a Pro or Max subscription: create a long-lived token once
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=...
# Gemini CLI: a Google AI Studio key (free tier available)
export GEMINI_API_KEY=...

docker compose -f bench/compose.yml run --rm myrmobench
```

## Load

What one colony node sustains, measured with [k6](https://k6.io) against the Docker deployment with
100,000 indexed trails. Each path runs alone for 30 seconds with 64 virtual users, so every number
describes that path only.

| Scenario | Request |
|---|---|
| Fingerprint lookup | `GET /v1/trails/by-fingerprint/{fp}` for known fingerprints |
| Semantic search | `POST /v1/search` with queries never seen before (embedding + vector search on every request) |
| Publish | `POST /v1/trails` (`202`) |
| Outcome report | `POST /v1/trails/{id}/outcomes` |

Reported per scenario: requests per second, p50 and p99 latency, error rate, and the machine it ran
on. The suite fails if any path has more than 1% errors or a p99 above one second.

```bash
docker compose -f docker-compose.yml -f bench/compose.yml up -d
python bench/load/populate.py http://localhost:8080 100000     # synthetic trails
docker compose -f docker-compose.yml -f bench/compose.yml run --rm loadtest
```

> [!WARNING]
> The bench overrides disable rate limiting and fill the colony with synthetic trails. Never run
> them against a production colony.

## Publishing results

Both runners write `bench/results/<run_id>/` (raw data, environment, versions) and update
`web/assets/bench-results.js`, which the website reads.
