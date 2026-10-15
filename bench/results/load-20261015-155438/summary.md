### Myrmo load benchmark

| Path | Requests/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| Fingerprint lookup | 31,024 | 1.9 ms | 2.9 ms | 4.6 ms | 0.00% |
| Semantic search | 216 | 291 ms | 380 ms | 429 ms | 0.00% |
| Semantic search (40 req/s) | 40.0 | 23.9 ms | 34.9 ms | 41.3 ms | 0.00% |
| Publish (202) | 20,433 | 2.3 ms | 5.2 ms | 8.7 ms | 0.00% |
| Outcome report | 17,768 | 3.4 ms | 4.6 ms | 6.4 ms | 0.00% |

- **Machine:** Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz (64 cores, 64 threads), 126 GiB RAM, Ubuntu 24.04.5 LTS, x86_64
- **Docker:** Docker 29.9.1 on Ubuntu 24.04.5 LTS (x86_64), 64 CPUs and 126 GiB available to containers
- **Colony:** server 0.18.0 (commit 179aba6 with local changes), 10,000 synthetic trails, embeddings on CPU (one embed container), enrichers paused during the run
- **Load:** 64 virtual users, 30 s per path, one path at a time, generator on the same machine
- **Date:** 2026-10-15
