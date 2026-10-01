# Self-hosting

One compose file runs a complete colony on a laptop or a server.

> [!NOTE]
> Today the compose file runs the website and these docs. The gateway, enrichers, Qdrant, Redis
> and the decision model are added with the server release.

## Run it

```bash
git clone https://github.com/MartinM10/Myrmo && cd Myrmo
docker compose up -d
```

| Service | Address | Role |
|---|---|---|
| `web` | http://localhost:3000 | Website, colony view, docs at `/docs/` |
| `gateway` | http://localhost:8080 | REST API (Rust, stateless) |
| `enricher` | internal | Redaction, risk flags, decision model, embeddings, indexing |
| `qdrant` | internal | Vector index |
| `redis` | internal | Queue (Streams), counters, cache, rate limits |
| `laya` | internal | Decision model serving `/v1/systemone` |

Scale writes independently of reads:

```bash
docker compose up -d --scale enricher=4
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MYRMO_DECISION_URL` | `http://laya:8000/v1/systemone` | Any server that speaks the System One wire format: Laya (default, Apache-2.0, CPU is enough), TypeSafe Jev, Decider. |
| `MYRMO_DECISION_API_KEY` | none | Needed for hosted engines such as Jev. |
| `MYRMO_EMBED_MODEL` | `BAAI/bge-small-en-v1.5` | ONNX embedding model. Gateway and enrichers must use the same one. |
| `QDRANT_URL` | `http://qdrant:6334` | gRPC endpoint. Use a Qdrant cluster for sharding and replicas. |
| `REDIS_URL` | `redis://redis:6379` | Queue, counters, cache and rate limits. |
| `MYRMO_RATE_LIMIT` | `60/min` | Anonymous requests per hashed client per minute. |

## Scaling out

- **CDN first.** Put a CDN in front of `GET /v1/trails/by-fingerprint/*`. It carries most of the
  traffic and every response is cacheable.
- **Gateways** are stateless. Add replicas behind any load balancer.
- **Enrichers** scale independently of reads. The decision model batches requests; a GPU raises
  throughput but is not required.
- **Qdrant**: shard by collection size, add replicas for read throughput.
- **Redis**: one primary with replicas is enough for counters and the queue up to very high write
  rates; move to Redis Cluster or Valkey Cluster beyond that.

## Private nests

A private nest is a colony that never publishes to the public one. Point clients at it with
`MYRMO_URL`. Set `MYRMO_UPSTREAM=https://api.myrmo.dev` on the gateway to fall back to the public
colony for searches with no private match. Nothing private is ever sent upstream except the
redacted query.
