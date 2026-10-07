"""What happens when many trails share one fingerprint?

    python bench/scale/populate.py http://localhost:8080 5000 --collapsing --start 5000000000
    python bench/scale/collisions.py http://localhost:8080

The fingerprint replaces paths, URLs and numbers by placeholders, so errors whose identifying name is one of them
(a Go module path, a Docker image, a git or registry URL, a file path) get the same key whatever the name: every
`no required module provides package github.com/x/y` is one key. bench/scale/generate.py can make trails of exactly
those families (`--collapsing`). With the colony holding `--per-key` of them for each of five keys, this measures:

  * the wrong answers: errors about names that were never published. Every trail under the key is about another name,
    so a trail returned by the exact lookup is wrong, and the lookup does not run the relevance check that the
    semantic search does.
  * the cost of a lookup of a key that holds many trails (the first request after the 30 seconds that a response
    is cached, against a key with a single trail).

Never run it against a production colony: it assumes the colony holds the collapsing trails.
"""

from __future__ import annotations

import argparse
import http.client
import json
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

from myrmo import Colony
from myrmo.fingerprint import fingerprint2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import COLLAPSING, make_trail  # noqa: E402

STRANGER_BASE = 20_000_000_000


def timed_get(base: str, path: str) -> tuple[int, float, int]:
    url = urlparse(base)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=120)
    t0 = time.perf_counter()
    conn.request("GET", path)
    res = conn.getresponse()
    body = res.read()
    return res.status, time.perf_counter() - t0, len(body)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8080")
    ap.add_argument("--per-key", type=int, default=0, help="a label for the report: about how many trails each key holds (SCARD fp:<key> in Valkey says exactly)")
    ap.add_argument("--strangers", type=int, default=500, help="searches per family about a name nobody published")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    colony = Colony(url=base, agent_id="bench_collisions_0001", cache_ttl=0, retries=0, timeout=120)

    print("five keys" + (f", about {args.per_key} trails under each" if args.per_key else "") + "\n")
    rows = []
    for family in COLLAPSING:
        error_type = family[2]
        # Find this family's key by asking about a name that is certainly not published.
        sample = None
        j = 0
        while True:
            t = make_trail(STRANGER_BASE + j, args.seed, collapsing=True)
            if t["problem"]["error_type"] == error_type:
                sample = t
                break
            j += 1
        key = fingerprint2(sample["problem"]["error_message"])
        status, cold, size = timed_get(base, f"/v1/trails/by-fingerprint/{key}")
        warm = [timed_get(base, f"/v1/trails/by-fingerprint/{key}")[1] for _ in range(5)]
        got = wrong = 0
        lat = []
        for k in range(args.strangers):
            t = make_trail(STRANGER_BASE + 1000 + k * 7, args.seed, collapsing=True)
            if t["problem"]["error_type"] != error_type:
                continue
            t0 = time.perf_counter()
            result = colony.search(t["problem"]["error_message"], runtime=t["environment"]["runtime"]["name"], limit=5)
            lat.append(time.perf_counter() - t0)
            got += 1
            wrong += 1 if result.hits else 0
        rows.append({"family": error_type, "fingerprint": key, "status": status, "first_request_ms": cold * 1000, "cached_ms": statistics.median(warm) * 1000, "response_kb": size / 1024,
                     "strangers": got, "wrong": wrong, "p50_ms": statistics.median(lat) * 1000 if lat else None})
    print("| Family (error type) | First request | Cached request | Response | Searches about an unpublished name | Got a trail (all wrong) |\n|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['family']} | {r['first_request_ms']:.0f} ms | {r['cached_ms']:.1f} ms | {r['response_kb']:.0f} KB | {r['strangers']} | {r['wrong']} ({100 * r['wrong'] / max(1, r['strangers']):.0f}%) |")
    if args.out:
        Path(args.out).write_text(json.dumps({"per_key": args.per_key, "rows": rows}, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
