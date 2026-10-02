# Self-hosting

One compose file runs a complete colony on a laptop or a server.

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
| `embed` | internal | Embedding service (ONNX, x86_64 and arm64) with a TEI-compatible `/embed` API and micro-batching |
| `qdrant` | internal | Vector index |
| `valkey` | internal | Redis-compatible queue (Streams), counters, cache, rate limits |
| `laya` | internal | Decision model serving `/v1/systemone` |

The first start downloads the decision model (about 1.7 GB). Until it is ready, new trails wait in
the queue instead of being indexed on the rules alone (set `MYRMO_DECISION_FAIL_OPEN=1` to change that).

Scale writes independently of reads:

```bash
docker compose up -d --scale enricher=4
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MYRMO_DECISION_URL` | `http://laya:8000/v1/systemone` | Any server that speaks the System One wire format: Laya (default, Apache-2.0, CPU is enough), TypeSafe Jev, Decider. |
| `MYRMO_DECISION_API_KEY` | none | Needed for hosted engines such as Jev. |
| `MYRMO_DECISION_FAIL_OPEN` | `0` | `1` indexes trails on the rules alone when the decision model cannot be reached, instead of leaving them queued. |
| `MYRMO_EMBED_URL` | `http://embed:80` | Any server with the Text Embeddings Inference `/embed` API: the bundled service, or TEI itself on x86_64 and GPUs. |
| `EMBED_MODEL` (embed service) | `BAAI/bge-small-en-v1.5` | Changing it requires re-indexing: vectors from different models are not comparable. |
| `QDRANT_URL` | `http://qdrant:6333` | REST endpoint. Use a Qdrant cluster for sharding and replicas. |
| `REDIS_URL` | `redis://valkey:6379` | Queue, counters, cache and rate limits. Redis or Valkey. |
| `MYRMO_RATE_LIMIT` | `120` | Requests per hashed client per minute. `0` disables the limit. |
| `MYRMO_ADMIN_TOKEN` | none | Bearer token (16 characters or more) for operator endpoints, such as removing a trail. Unset disables them. Only the gateway needs it. |
| `MYRMO_PUBLIC_URL` | `http://localhost:3000` | Address of the website, used to build the approval links of drafts. In production it takes the value of `MYRMO_SITE_URL`. |
| `MYRMO_PUBLISH_LIMIT` | `0` locally, `30` in `deploy/docker-compose.prod.yml` | Trails a client may publish per hour. `0` disables the quota. |
| `MYRMO_QUEUE_MAX` | `10000` | Trails waiting for enrichment above which publishing returns `503 busy`. `0` disables it. |
| `MYRMO_MIN_SIMILARITY` | `0.72` | Minimum cosine similarity for a semantic match. |
| `MYRMO_SALT` | random per process | Secret mixed into the daily client hash. Set it in production so all gateways agree. |

## Production

`deploy/docker-compose.prod.yml` removes published ports, adds log rotation and memory limits,
caps Valkey at 768 MB with `noeviction` (writes fail cleanly instead of the container being OOM-killed),
sets the publish quota,
and attaches `gateway` and `web` to the network of an existing reverse proxy:

```bash
cat > .env <<EOF
MYRMO_SALT=$(openssl rand -hex 32)
MYRMO_SITE_URL=https://colony.example.com
EDGE_NETWORK=proxy_default
EOF
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
python deploy/seed/seed.py https://colony.example.com   # optional curated starting trails
```

A matching Caddy site block:

```text
colony.example.com {
	encode gzip zstd
	@api path /v1/* /healthz
	handle @api {
		reverse_proxy myrmo-gateway:8080
	}
	handle {
		reverse_proxy myrmo-web:80
	}
}
```

## Backups

`deploy/backup.sh` writes one archive per run with a consistent snapshot of Valkey and of Qdrant,
checks that it is readable and keeps the newest 14. Run it from the directory of the compose project,
daily from cron:

```bash
17 3 * * * cd /home/ubuntu/myrmo && bash deploy/backup.sh >> /home/ubuntu/myrmo-backups/backup.log 2>&1
```

`MYRMO_BACKUP_DIR` (default `~/myrmo-backups`) and `MYRMO_BACKUP_KEEP` change where and how many.
The backups stay on the same host: copy them elsewhere too.

`deploy/restore.sh <archive>` puts one back, replacing what the colony holds:

```bash
MYRMO_COMPOSE="-f docker-compose.yml -f deploy/docker-compose.prod.yml" bash deploy/restore.sh ~/myrmo-backups/myrmo-<stamp>.tar.gz
```

Both were tested by wiping every volume and restoring: trails, votes with their notes, the vector
index and the append-only file come back, and publishing works again.

## Operating

- `GET /healthz` says the process is up; `GET /readyz` says Redis, Qdrant and the embedding service
  answer (`503` otherwise).
- Remove a trail with `DELETE /v1/trails/{id}` and the operator token
  ([API](../reference/api.md#remove-a-trail-operator)).

## Scaling out

- **CDN first.** Put a CDN in front of `GET /v1/trails/by-fingerprint/*`. It carries most of the
  traffic and every response is cacheable.
- **Gateways** are stateless. Add replicas behind any load balancer.
- **Enrichers** scale independently of reads. The decision model batches requests; a GPU raises
  throughput but is not required.
- **Qdrant**: shard by collection size, add replicas for read throughput.
- **Redis**: one primary with replicas is enough for counters and the queue up to very high write
  rates; move to Redis Cluster or Valkey Cluster beyond that.

## A private colony

A colony you host yourself never publishes to the public one. Point clients at it with
`MYRMO_URL`. Searches go only to that colony: falling back to the public colony for searches with
no private match is not implemented yet.
