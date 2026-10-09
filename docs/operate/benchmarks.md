---
title: "Benchmarks: MyrmoBench, retrieval, scale and load tests"
description: "MyrmoBench measures whether following a trail helps agents; the retrieval suite measures whether a search finds the right trail; the scale suite does it with a million trails; the load suite measures what one colony node sustains. Reproducible with one command."
---

# Benchmarks

Suites in `bench/`: MyrmoBench, load, retrieval, scale and the leak tests. Each publishes its raw results, and the website only shows numbers from published runs.

> [!IMPORTANT]
> No run, no number. Until the first public run, the website shows these benchmarks as pending.

## MyrmoBench

> [!WARNING]
> **Built, not yet run.** The runner and four of the twelve tasks exist in `bench/myrmobench/` and pass their dry run
> (each fails as described and its reference fix passes the hidden check). No agent has been run on them, so no number on
> this site comes from MyrmoBench. The other eight tasks are specified below and not built.

Does following a trail actually save agents work?

**Tasks.** Twelve Docker containers (the first four are built), each with a real breakage agents hit every day:

| Task | Breakage |
|---|---|
| `py-distutils` | numpy 1.24 on Python 3.12 |
| `node-openssl` | webpack 4 on Node 18+ (OpenSSL 3) |
| `uv-path` | uv installed in a Dockerfile, missing from PATH |
| `git-ownership` | git "dubious ownership" in a CI container |
| `pg-scram` | an old pure-Python driver (pg8000 1.12) against PostgreSQL 16, which cannot do SCRAM-SHA-256 |
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

The four built tasks: `uv-path`, `node-require-esm`, `tls-corporate-ca` and `pg-scram`. They were chosen because the fix
depends on a detail of the environment (where an installer puts a binary, which major version of a package is still
CommonJS, which authentication a server speaks, what a company CA is), not on the user's own code. Whether a model solves them
on the first try has **not** been measured; the "without Myrmo" arm of the first run is that measurement.

```bash
python bench/myrmobench/run.py list
python bench/myrmobench/run.py plan                    # runs, models and the most they should cost
python bench/myrmobench/run.py dry-run                 # builds each task, proves it fails and that its fix passes; free

# Spends money. Needs an empty colony (docker compose up -d) and a key:
export ANTHROPIC_API_KEY=...        # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
python bench/myrmobench/run.py run --execute --approved-usd 80
python bench/myrmobench/publish_results.py bench/results/myrmobench-<stamp>   # writes the website numbers
```

With `ANTHROPIC_API_KEY` the runs are billed per token; with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) they use the
quota of a Claude subscription and cost no money, but 44 agent sessions can use up a plan's usage window, so spread them over
days. In that case the cost the runner shows is notional and `--approved-usd` only works as a brake.

To measure cheaper models as followers, run OpenCode instead (`--agent opencode`). It takes models as `<provider>/<model>`
(`opencode models` lists them once you are signed in; an OpenCode Go subscription gives `opencode-go/<id>`) and the key in
`OPENCODE_API_KEY`:

```bash
export OPENCODE_API_KEY=...
python bench/myrmobench/run.py plan --agent opencode --pioneer opencode-go/<id> --followers opencode-go/<id>
python bench/myrmobench/run.py run  --agent opencode --pioneer opencode-go/<id> --followers opencode-go/<id> \
    --execute --approved-usd 15 --tasks uv-path --repetitions 2
```

The agent has the same tools as the Claude Code runs (shell, files) and no web access, and Myrmo is its only MCP server in the
"with" condition. Models without a known price are costed at an assumed, deliberately high price, so the ceiling and the
spending brake never come out too low; where the agent reports no cost, the brake counts tokens at that price. Results of
different agents are different runs: the published numbers name the agent and the models.

`run` does nothing without `--execute` and `--approved-usd`, refuses an amount below the plan's ceiling, and stops when
the cost the agent CLI reports reaches the approved amount. Each run starts from a fresh container that has the agent
installed; the hidden `check.sh` is copied in only after the agent has finished. Two agents are implemented, Claude Code
and [OpenCode](https://opencode.ai); Gemini CLI is not. Tokens count input, output and cache. `publish_results.py` refuses a run without follower
runs both with and without Myrmo. The plan's per-run token budget is a guess, to be replaced by the first measured run.

## Coverage

How likely is it that an error an agent hits finds a trail that solves it? `bench/coverage/` holds 91 real breakages, each
reproduced in a pinned Docker image, from eight ecosystems (Python, Node, JVM, Go, Rust, .NET, Docker and Kubernetes, TLS and
platform). They are split at random into 46 **candidates**, from which trails were made, and 45 **reserved**, which no trail
was made from. Coverage is measured on the reserved half, so it says how a colony does on errors it was not built from.

| Colony | Trails | Hit | A trail was there but did not come back | Wrong trail returned | Nothing returned |
|---|---|---|---|---|---|
| The public colony on 2026-10-08, loaded locally | 30 | 0% | 2% (1 of 45) | 7% (3) | 91% (41) |
| With 45 reproduced trails added | 75 | 4% (2) | 16% (7) | 18% (8) | 62% (28) |
| With a third batch added | 90 | 4% (2) | 16% (7) | 31% (14) | 49% (22) |
| Same colony, with the identifier rule | 90 | 4% (2) | 16% (7) | 20% (9) | 60% (27) |
| The public colony after a fourth batch (11 more trails, measured on production) | 101 | 4% (2) | 16% (7) | 20% (9) | 60% (27) |

The second row onwards runs with the similarity floor at 0.75; the last row also applies the identifier rule (a search that
quotes a name or an error code, such as `'url_quote'` or `ERR_REQUIRE_ESM`, only returns trails that mention one of them). A *wrong trail* is a trail that came back, none of which solves the
error; most are about the same family of problem (another certificate error, another NumPy 2 removal). "Nothing returned" is
the right answer when nothing in the colony solves the error. The "did not come back" column counts the cases where something
in the colony does solve it by the rubric but the search did not return it: the floor and the name check trade those against
wrong trails (see the floor sweep in [Retrieval](#retrieval)).

Reading it honestly: a colony of about a hundred trails answers about one reserved error in twenty, and returns a wrong trail for one in five.
That is what a small, deliberate set of recent breakages buys. Coverage grows with the number of ecosystems and breakages
covered, not with the number of trails in one, and the false positives grow with the corpus unless relevance keeps up. The 91
lines are a small sample chosen by us, and the rubric that decides "solves" is a heuristic; `bench/coverage/README.md` says how
it works.

## Decision model

The enricher asks a System One engine to categorise each trail, score its quality, and score prompt injection and sensitive
content. `bench/decision/engine_eval.py` asks an engine the same questions the server asks, over two small labelled sets of the
repository (63 injection texts and 37 benign ones; 30 trails with the category the project expects, 4 of them not yet confirmed
by the owner), so engines can be compared with the colony's own wording. Run on 2026-10-09 with Laya (the bundled engine, on CPU,
four requests at a time) and Jev (hosted):

| | Laya | Jev |
|---|---|---|
| Category right (30 trails) | 5 | 18 |
| Category right, without the 4 unconfirmed | 4 of 26 | 17 of 26 |
| Injections caught at 0.5 (63) | 56 | 58 |
| False alarms at 0.5 (37 benign) | 16 | 11 |
| Injections caught at 0.9 | 42 | 47 |
| False alarms at 0.9 | 4 | 3 |
| Median call | 2,149 ms | 328 ms |

Laya's category answers are close to chance and as confident when wrong (0.67) as when right (0.66); Jev's confidence is higher
when right (0.86) than when wrong (0.77), which is what lets the server trust a category only above a confidence and a margin.
Both are indications from small sets: 30 and 100 texts, no confidence intervals, a latency that depends on the machine for
Laya. The rules, not the model, decide whether a trail is rejected for injection (`MYRMO_MODEL_INJECTION_GATE` is off), and
these sets measure the model alone. The raw answers of that run were not kept: the script reproduces them.

In production the time from submitting a trail to its being indexed was a median 12.9 s with Laya (16 trails of one batch,
largest 15.1 s) and 2.3 s with Jev (11 trails of the next, largest 2.5 s). Publishing is still limited by the quota per address,
and writing a reproducible task is the slow part of populating a colony; the engine was not the bottleneck there.

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

### Latest results

Run `load-20261001-1921`: one Intel Core i7-8700K desktop (6 cores, 12 threads, Docker Desktop on
Windows) running the whole colony **and** the load generator, 100,100 indexed trails, 64 concurrent
clients, enrichers paused so each path is measured alone. Zero errors on every path.

| Path | Requests/s | p50 | p99 |
|---|---|---|---|
| Fingerprint lookup | 27,499 | 1.9 ms | 8.6 ms |
| Semantic search, 40 req/s | 40 | 17.6 ms | 27.8 ms |
| Semantic search, saturated | 88 | 735 ms | 2.3 s |
| Publish (`202`) | 10,536 | 5.1 ms | 18.0 ms |
| Outcome report | 12,046 | 4.8 ms | 13.4 ms |

What this says:

- The fingerprint path, where repeat errors go, sustains tens of thousands of requests per second
  on one machine before any CDN is added.
- Semantic search is bounded by the CPU embedding service (about 88 embeddings per second here).
  Below that rate it answers in under 30 ms; above it, requests queue. It scales by adding `embed`
  replicas or moving embeddings to a GPU, independently of the gateway.
- Publishing and outcome reports only touch Valkey on the request path, so they stay in the
  single-digit milliseconds.

Raw output: `bench/results/load-20261001-1921/`.

## Retrieval

When an agent searches for an error, does Myrmo return the trail that solves it? No agent and no model is
involved, so a run takes about a minute and costs nothing. `bench/retrieval/run.py` publishes a corpus to an
empty colony and searches the way an agent does (the Python SDK: exact fingerprint first, semantic search when
that finds nothing).

| Searches | What they are |
|---|---|
| Positives | The error of a published trail as it would look on another machine: paths, versions, ports and line numbers changed; wrapped in another exception; with a stack header; cut to 60%; without its type prefix. Scored by whether the trail comes back and where. |
| Negatives | Errors no trail solves, and look-alikes that name another module or key than a published trail, where the name decides the fix. The right answer is nothing: a trail returned is a wrong answer. |
| Floor sweep | The colony returns every semantic match above its similarity floor (0.72). The stored scores show what a stricter floor would have found and stopped. |

```bash
docker compose -p myrmo-retrieval -f docker-compose.yml -f bench/compose.yml up -d gateway enricher valkey qdrant embed
python bench/retrieval/run.py http://localhost:8080 --out bench/results/retrieval-YYYYMMDD
```

The corpus (`bench/retrieval/corpus.jsonl`) is a snapshot built by `build_corpus.py`; every line records where
the trail came from. `negatives.json` says which trails are fair answers to a negative, judged by hand. Use a
local colony, never production: the runner publishes the corpus and refuses a colony that already holds trails.

### Latest results

Run `retrieval-20261007-0811-fp2`: 46 published trails (38 made by the seed factory from commands run in containers, 8
hand-made seeds; they include trails of tasks the publication policy excludes, which make good tests but are not
published), a virtual machine with 64 vCPUs, embeddings on CPU, heuristic enrichment, similarity floor 0.72, error
fingerprint fp2.

| Variant | Searches | Top 1 | Top 3 | Wrong trail on top | Answered by |
|---|---|---|---|---|---|
| Error line as published | 37 | 100% | 100% | 0% | fingerprint 37 |
| Paths, versions, ports, lines changed | 37 | 100% | 100% | 0% | fingerprint 36, search 1 |
| Wrapped in another exception | 37 | 97% | 97% | 0% | fingerprint 28, search 9 |
| With a stack header | 37 | 86% | 86% | 8% | search 37 |
| Cut to 60% | 16 | 100% | 100% | 0% | search 16 |
| Without its type prefix | 29 | 100% | 100% | 0% | fingerprint 20, search 9 |

| Should find nothing | Searches | Wrong answers |
|---|---|---|
| Errors no trail covers | 39 | 5 (13%) |
| Look-alikes (another module or key) | 7 | 0 |

| Similarity floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 (default) | 66 of 72 | 3 | 5 of 46 |
| 0.75 | 62 of 72 | 1 | 1 of 46 |
| 0.78 | 59 of 72 | 0 | 0 of 46 |
| 0.85 | 34 of 72 | 0 | 0 of 46 |

The same corpus and seed with the first fingerprint (fp1) are in `bench/results/retrieval-20261007-0711/`. What changed,
and what did not:

- **The cheap path answers most repeats now.** Of the 193 searches that are a repeat of a published error, 121 (63%)
  were answered by the fingerprint lookup, against 22 (11%) with fp1, and those answers take 1 to 2 ms instead of
  17 to 25 ms: no embedding, no vector search, cacheable at an edge. The rest go to the semantic search as before.
- **Finding the trail did not get worse.** Top 1 is 100% for the error as published, on another machine and without its
  type prefix (it was 100%, 97% and 97%), and 97% wrapped in another exception. Pasting a whole stack header still
  fails (86%, and in 8% the first trail is the wrong one), which is why the instructions ask for the exact error line only.
- **No new wrong answers.** Five of 39 unrelated errors get a trail, the same five as before: they come from the semantic
  search, which fp2 does not touch. At 0.78 none did, and 7 of 72 semantic answers were lost. Nothing is tuned on these
  numbers: with more trails in the colony there are more near neighbours, so the right floor has to be measured again.
- **Short messages found more often.** Nine corpus trails have an error message of fewer than three words (for example
  `EACCES`). Their searches found the trail in 30 of 36, against 21 of 36 with fp1. They are still weak trails; they
  come from older seed batches.
- **The corpus is small and made by us.** 46 trails say little about recall at a million, and the variants are
  generated, not written by agents. This measures the robustness of search to the changes between machines, not how
  often a real agent finds a real answer. That is what MyrmoBench is for.

### With 86 trails, and the floor

Run `retrieval-20261008-lot001`: the corpus grew from 46 to 86 trails (37 more made by the seed factory, in eight
ecosystems, and three older ones), same machine type, floor 0.72, fp2.

| Variant | Searches | Top 1 | Top 3 | Wrong trail on top |
|---|---|---|---|---|
| Error line as published | 76 | 100% | 100% | 0% |
| Paths, versions, ports, lines changed | 76 | 100% | 100% | 0% |
| Wrapped in another exception | 76 | 100% | 100% | 0% |
| With a stack header | 76 | 89% | 89% | 5% |
| Cut to 60% | 48 | 96% | 98% | 2% |
| Without its type prefix | 59 | 100% | 100% | 0% |

| Should find nothing | Searches | Wrong answers |
|---|---|---|
| Errors no trail covers | 39 | 6 (15%) |
| Look-alikes (another module or key) | 7 | 1 (14%) |

| Similarity floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 156 of 166 | 5 | 7 of 46 |
| 0.75 | 152 of 166 | 4 | 2 of 46 |
| 0.78 | 146 of 166 | 3 | 1 of 46 |
| 0.80 | 137 of 166 | 2 | 0 of 46 |

As the earlier run predicted, more trails mean more near neighbours: wrong answers to the 46 negatives went from 5 to 7 at
0.72. A colony's default is now **0.75** (`MYRMO_MIN_SIMILARITY`): it stops five of those seven and loses four of 166
semantic answers (2%). The benchmark colony itself keeps running at 0.72, so that the sweep sees every match above it.

Two more changes came from reading the false positives of a coverage run: a semantic hit no longer counts the parts of a
file system path in the query (`/usr/local/lib/python3.12/site-packages/...`) as words in common, and a few filler words
(`find`, `because`, `support`, `main`, `thread`, `attribute`, `object`) are no longer distinctive.

The false positives of the third batch (14 of 45) were mostly neighbours in the same family: two Node errors that differ only in
the `ERR_*` code, two Flask and Werkzeug import errors that differ in the name. The identifier rule takes those out (9 of 45)
without losing a retrieval result: the same 110-trail corpus gives the same top-1 rates with and without it
(`retrieval-20261009-identifiers`), and 5 of 39 errors that no trail covers get a wrong trail instead of 6. A first version
treated any quoted word as a name and lost six searches whose quote held a URL, an address or a host name; those values change
from one machine to the next and no longer count.

### Fingerprint keys

The exact lookup (`GET /v1/trails/by-fingerprint/{fp}`) is what makes a colony cheap to serve: a repeat error is one
cacheable request, against an embedding and a vector search for every semantic one. The first key, fp1, included the
error type, which a trail declares (what its author chose) and a searcher can only guess from the error line. On the 23
distinct trails that agents wrote in production, the key a client computed from the exact message matched the trail's
own in 4 (17%): a qualified class name against a simple one (`java.lang.NullPointerException` against
`NullPointerException`), a label that is not in the message at all (`mojibake`, `HTTP 429`), a leading `Error:` or
`ERROR:` against the code the trail declares, a wrapper exception around the one that was declared. The runtime also
fragmented the key: `java`, `jvm` and an empty runtime were three keys.

`bench/fingerprint/compare.py` compares fp1 with fp2, which hashes the message alone after dropping the labels that wrap
it, on those production trails and on the 46 trails of the retrieval corpus (trails whose own key is matched by the key
computed from each kind of search):

| Key | Production, exact line | Production, other machine | Production, wrapped | Corpus, exact line | Corpus, wrapped |
|---|---|---|---|---|---|
| fp1 (runtime and guessed type) | 4 of 23 | 4 of 23 | 0 of 23 | 12 of 46 | 0 of 46 |
| fp2 | 23 of 23 | 22 of 23 | 19 of 23 | 46 of 46 | 36 of 46 |

The real case an agent reported, `CompletionException: ...IllegalStateException: Recursive update`, was found by none of
its phrasings with fp1, not even the message exactly as stored, and is found by four of five with fp2. No two trails
shared a key and none of 46 unrelated or look-alike searches hit one.

What fp2 gives up, and what is still unmeasured: two exception classes with the same text share a key (`ValueError:
invalid value` and `TypeError: invalid value`), very short generic messages (`permission denied`) will collide across
tools, and the runtime is not in the key, so a message that two runtimes print the same way is one key. With 70 trails the
absence of collisions says little about a colony of thousands; the lookup returns each trail with its own runtime and error
type, and the semantic search still ranks by environment overlap. The collision rate has to be measured again as the
colony grows.

## Scale

Does the colony hold up with a million trails, and does a search still find the right one among them? `bench/scale/`
fills a colony with varied trails and measures it. `generate.py` makes trails that differ the way real ones do: 34
families of errors (a missing module, a refused connection, a failed build...) about made-up names, so no trail is
about a real project and two trails of one family differ in one identifier. Each trail is a function of its number, so
a test can regenerate trail 731,204 without a ledger and ask whether it can be found. `bench/load/populate.py` makes
variants of nine seed trails: enough for throughput, useless for search.

| Script | What it does |
|---|---|
| `populate.py` | Publishes trails `start` to `start + count - 1` with several processes and connections, and waits until the colony has indexed them. |
| `needles.py` | Searches for trails picked at random, as published, wrapped in another exception and without their exception class, and for **strangers**: errors of the same families about names nobody published. Every trail in the colony is about another name, so the right answer is nothing. |
| `collisions.py` | With many trails under one fingerprint (a Go module path, a Docker image, a URL: the fingerprint replaces them by a placeholder), measures the wrong answers and the cost of a lookup. |
| `compose.yml`, `haproxy.cfg` | Embedding replicas behind a least-connections balancer, and more enrichers, for a machine with many cores. |

```bash
docker compose -p myrmo-scale -f docker-compose.yml -f bench/compose.yml -f bench/scale/compose.yml up -d \
    gateway enricher valkey qdrant embed embedlb
python bench/scale/populate.py http://localhost:8080 1000000 --wait
python bench/scale/needles.py http://localhost:8080 --size 1000000
```

Use a local colony, never production. Raw output: `bench/results/scale-20261007/`. Everything below ran on one virtual
machine with 64 vCPUs (Xeon Platinum 8358) and 125 GB of RAM, the whole stack and the load generator together,
embeddings on CPU, enrichment heuristic.

### The new server is not slower

The same 100,002 trails, filed with server 0.4.0 and then served by 0.5.0, which moved them to fp2 on start (113 seconds
for 100,002 trails, including the start of the container). Requests per second, with p50 and p99 in milliseconds; 64
virtual users, 30 seconds per path, no errors on any path.

| Path | 0.4.0 | 0.5.0, run 1 | 0.5.0, run 2 |
|---|---|---|---|
| Fingerprint lookup | 24,981 (2.3 / 6.2) | 24,889 (2.4 / 5.5) | 25,197 (2.3 / 5.3) |
| Semantic search, saturated | 807 (75 / 153) | 854 (71 / 139) | 869 (71 / 131) |
| Semantic search, 40 per second | 40 (22 / 29) | 40 (21 / 27) | 40 (21 / 28) |
| Publish (`202`) | 18,653 (2.6 / 10.4) | 18,185 (2.7 / 10.5) | 18,677 (2.6 / 10.4) |
| Outcome report | 14,133 (4.2 / 7.7) | 14,147 (4.2 / 8.6) | 12,985 (4.6 / 8.5) |

Two runs of the same server differ by up to 8% (outcome reports), so the differences above are noise. These numbers are
not comparable with the run of 2026-10-01 on a desktop: the machine is another one.

### A million trails

| Path | 100,002 trails | 1,000,000 trails |
|---|---|---|
| Fingerprint lookup | 24,889 (2.4 / 5.5) | 25,600 (2.3 / 5.2) |
| Semantic search, saturated | 854 (71 / 139) | 785 (76 / 173) |
| Semantic search, 40 per second | 40 (21 / 27) | 40 (21 / 28) |
| Publish (`202`) | 18,185 (2.7 / 10.5) | 18,171 (2.7 / 10.4) |
| Outcome report | 14,147 (4.2 / 8.6) | 13,699 (4.3 / 8.3) |

Ten times the trails cost the semantic search about 8% of its throughput; the other paths do not move. Filling the
colony: the embedding service is the limit (it runs on CPU), and with 16 replicas of 3 threads behind a balancer, using
48 of the 64 cores, the colony indexed **420 to 450 trails per second**, the same from 100,000 to a million. Behind plain
Compose DNS the replicas were unevenly loaded (300% CPU in some, 140% in others) and it was 340 per second. A million
trails took about 45 minutes. They take 3.0 GB in Qdrant (837 MB resident), 871 MB in Valkey (peak 1.27 GB) and 808 MB in
the gateway.

### Finding one trail among a million

1,500 random trails and 1,500 strangers per size, searched the way an agent does (the fingerprint lookup first, the
semantic search when that finds nothing). A trail counts as found when the one that comes back has the same fingerprint.

| Colony | Needle as published | Without its exception class | Wrapped in another exception: top 1 (not found, wrong on top) | Strangers that got a trail |
|---|---|---|---|---|
| 100,000 | 100% | 100% | 96.6% (1.5%, 3.4%) | 94.2% |
| 500,000 | 100% | 100% | 94.9% (3.2%, 5.0%) | 94.3% |
| 1,000,000 | 100% | 100% | 92.7% (4.5%, 7.2%) | 94.5% |

Latency stays flat: the semantic path answers in 24 to 28 ms (p50) and 32 to 38 ms (p99) from 100,000 to a million, and
a fingerprint hit in 1 to 2 ms.

What this says, and what it does not:

- **A repeat of an error is found, at any size.** The error as published or without its class is found every time, by
  the fingerprint lookup. Wrapped in a wrapper that fp2 does not drop (`RuntimeError: Command failed: ...`), the search
  falls to the semantic path and loses a few points as the colony grows.
- **A search about a name nobody published got a trail about another one, 94% of the time** (server 0.5.0, before the name check below). With 46 trails, the 7 look-alike searches of the Retrieval suite got no wrong answer. The cause is in `relevance.rs`: a semantic hit is shown if its similarity is
  0.92 or more (two messages that differ in one word almost always reach it) or if it shares **any** distinctive word
  with the query, and among thousands of trails of one kind there is always a sibling that does both. A generic
  fix may still help (`pip install <name>` is the same advice for any name), so this is noise and sometimes wrong
  advice, not always a wrong answer; but it is what the search returns when the colony has no answer.
- **A higher similarity floor does not fix it.** At 500,000 trails the right answers of the semantic search have a median
  similarity of 0.948 and the strangers' 0.903, with a wide overlap:

| Floor | Right answers kept | Strangers still answered |
|---|---|---|
| 0.92 (today) | 91% | 25% |
| 0.94 | 68% | 7% |
| 0.95 | 45% | 1% |
| 0.96 | 23% | 0% |

  The relevance check has to look at the names, not only at the score. `needles.py` is the test for it: the strangers'
  figure is what a fix has to bring down without losing the needles. It does now: see [the name check](#the-name-check).
- **The haystack is synthetic.** Made-up names in 34 templates make siblings far more alike than real errors are, so 94%
  is the figure for a colony with thousands of trails of one kind, not a forecast. The exact-key results (100%) are
  deterministic by construction: they show that nothing breaks with size, not how often a real agent finds an answer.

### The name check

The fix for the strangers is in the semantic path of the search (`relevance.rs`). A query that looks like an error line (it
has a colon, a quote or a backtick) is compared with each candidate: if they share most of their words (three fifths of
the longer one, half when both are very short) and each has a name the other lacks, the candidate is dropped, whatever its
similarity. Names are the words left once the labels (the exception class, `error:`) are dropped and the generic words
(`install`, `failed`, `python`...) are ignored. A query that only adds words (a wrapper, a stack), only lacks words (cut
short), is a sentence, or shows another machine's paths and versions does not conflict. The parameters were chosen on 3,000
strangers from the same generator (so the synthetic figures below are not an independent test of the parameters) and
checked on variants of the real trails of the retrieval corpus and of production (295 variants, none dropped) and on 14
sentences written by hand (none dropped), which are independent of it.

Same haystack, same seed, same searches, server 0.5 without and with the check:

| Colony | Strangers that got a trail | Wrapped needle found on top | Wrapped needle: a wrong trail on top |
|---|---|---|---|
| 100,000, before | 94.2% | 96.6% | 3.4% |
| 100,000, with the check | **7.5%** | **99.6%** | **0.3%** |
| 1,000,000, before | 94.5% | 92.7% | 7.2% |
| 1,000,000, with the check | **7.6%** | **98.3%** | **1.1%** |

The needles as published and without their class are found 100% of the time, as before. The check also finds the right
trail more often, because a sibling about another name no longer takes its place. It costs a little: the semantic search of
a stranger takes 29.7 ms (p50) against 27.9 ms at a million trails, and under load the semantic search goes from 785 to
764 requests per second (within the run-to-run noise), with every other path unchanged. The retrieval benchmark of
real errors gives the same figures as before: no right answer is lost.

What it does not catch (about 7% of the strangers):

- Names that the fingerprint's normalisation turns into a placeholder: a relative path such as `fatal error: lib/x.h`, and
  an identifier that mixes letters and digits and has 12 characters or more (`smoke_eb8083ea`).
- Lines without a colon, a quote or a backtick (`Back-off restarting failed container x in pod y`).
- Names of one letter, two-letter names that are common words (`it`, `no`), and names in the list of generic words (`node`, `python`).

### Keys that gather many trails

The fingerprint replaces paths, URLs and long numbers by placeholders, which is what makes it machine-independent and also
what erases the name in some errors: a Go module path, a Docker image, a git or registry URL, a file path. Every
`no required module provides package github.com/x/y` is one key. With five such keys holding 1,300 to 2,000 trails each, and
again with 5,200 to 6,000:

| Under each key | First lookup after the cache expires | Cached lookup | Searches about an unpublished name that got a trail |
|---|---|---|---|
| 1,300 to 2,000 trails | 256 to 482 ms | 0.7 to 1.0 ms | 100% (500 of 500) |
| 5,200 to 6,000 trails | 528 to 759 ms | 0.9 to 1.0 ms | 100% (500 of 500) |

Three consequences, all from the same cause:

- **Wrong answers through the exact path.** The fingerprint lookup does not run the relevance check, so a search about a
  package nobody published is answered with trails about other packages, with `match.via: fingerprint` and a score of 1.
- **A lookup costs as much as the key is big** when its answer is not cached (30 seconds): the colony reads every trail
  under the key to rank them and returns five. 0.5 to 0.8 seconds at 5,000 trails; it grows with them.
- **Publishing under such a key slows down:** each new trail is compared with every sibling to see whether it repeats
  one, and enrichment dropped from 450 to 66 trails per second while those keys grew.

fp1 had the same collapse (it replaced the same tokens); fp2 does not make it worse, but it does not cure it, and the
benchmark makes it measurable. The ways out are to keep what identifies in those families, to check the answer of an
exact lookup against the query, or to stop reading every sibling.

The cost half is closed: a key now keeps at most 64 trails (`MYRMO_MAX_PER_FINGERPRINT`), so the lookup, the search and the
merge check read at most that many. A trail that arrives at a full key is still indexed and found by search, which runs the
relevance check. Measured on one desktop with five keys holding about 1,000 trails each (5,000 trails, same population with
the limit off and on):

| | First lookup after the cache expires | Cached lookup | Enrichment | Searches about an unpublished name that got a trail |
|---|---|---|---|---|
| No limit (about 1,000 under each key) | 88 to 123 ms | 0.8 to 0.9 ms | 99 trails/s | 100% (300 of 300) |
| 64 per key | 7 to 20 ms | 0.8 ms | 99 trails/s | 100% (300 of 300) |

The first lookup no longer grows with the key. The collapse of enrichment shows up with bigger keys: 28,000 colliding trails
(about 5,600 under each of the five keys), same machine and population, limit off and on:

| | First lookup after the cache expires | Time to index 28,000 trails | Enrichment, overall (at the end) | Searches about an unpublished name that got a trail |
|---|---|---|---|---|
| No limit (5,500 to 5,700 under each key) | 550 to 709 ms | 903 s | 31 trails/s (3/s) | 100% (300 of 300) |
| 64 per key | 7 to 20 ms | 277 s | 101 trails/s (41/s) | 100% (300 of 300) |

Indexing the same trails takes a third of the time, and the cached lookups are unchanged. The limit makes the wrong
answers cheaper, not rarer; what makes them rarer is the next change.

**Checking the names the key erases.** The SDKs and the colony now compare the module, image or repository two messages name
([Fingerprints](../concepts/fingerprints.md#names-the-key-erases)). With 5,000 colliding trails (64 under each key) and 300
searches per family about a name nobody published:

| Family | Searches that got a trail (all wrong), before | After |
|---|---|---|
| no required module provides package (Go modules) | 100% (55 of 55) | 0% (0 of 55) |
| pull access denied (images) | 100% (62 of 62) | 0% (0 of 62) |
| unable to access (git URLs) | 100% (71 of 71) | 0% (0 of 71) |
| E404 (registry packages) | 100% (54 of 54) | 0% (0 of 54) |
| FileNotFoundError (file paths) | 100% (58 of 58) | 100% (58 of 58) |

A file path is the machine's, not a name, so that family is unchanged: the same fix (create the file, change the directory)
often serves any path, which is why those answers are arguably not wrong. On the 121-trail retrieval corpus the same
searches give the same results with and without the check (top-1 100, 100, 99, 92, 100 and 96% for the six variants, and
8 of 39 errors that no trail covers still get a trail: that figure rose from 5 of 39 with the 11 trails of the fourth batch,
before this change, and is the next thing to look at).

## Leak test bank

How much sensitive data gets through, measured instead of assumed. `bench/leaks/cases.json` holds 42
cases. Each plants one string in one field of an otherwise valid trail (a log line, an error message,
a step, a command, a diff) and says what should happen to it:

| Expectation | Meaning |
|---|---|
| `caught` | The string must not be readable afterwards: redacted, or the trail rejected. |
| `gap` | A known hole that nothing catches yet. Listed so it is measured, not forgotten. |
| `flagged` | A dangerous command. The trail may be indexed, but its risk level must come back high (or the trail rejected). |

```bash
python bench/leaks/run.py            # against a local colony: docker compose up -d
```

The runner publishes real trails: use a local colony, never production. It fails when something
that must be caught escapes, and prints every case.

Latest run, local colony with the Laya decision model:

| Category | Result |
|---|---|
| Secrets with a recognisable shape (19 formats) | 19 of 19 caught |
| Personal data: e-mail, phone, IPs, home paths on three systems | 7 of 7 caught |
| Internal host name in a log line | caught |
| Instructions aimed at the agent that reads the trail | 4 of 4 caught |
| Dangerous commands (`curl \| sh`, reading credentials, `rm -rf /`) | flagged or rejected |
| **Known gaps** | 8 of 8 still escape: an unlabelled random secret, a secret in a sentence, a person's name, an internal URL on a company domain, a customer name, a private package name, proprietary code in a diff, and a polite instruction with no trigger words |

The first run found a real hole (a bare internal host name in a DNS error was not redacted), which
is fixed and now covered by the shared redaction vectors. The known gaps are what a fine-tuned
decision model and a quarantine for unknown publishers are meant to close.

## Publishing results

The load runner writes `bench/results/<run_id>/` (raw data, environment, versions) and updates
`web/assets/bench-results.js`, which the website reads. The retrieval, fingerprint and scale runs write their raw output to
`bench/results/` too and are published on this page; they are not on the website yet.
