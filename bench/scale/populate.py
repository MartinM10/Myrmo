"""Fill a colony with the varied trails of generate.py, as fast as the machine allows.

    python bench/scale/populate.py http://localhost:8080 1000000
    python bench/scale/populate.py http://localhost:8080 5000 --collapsing --start 2000000

Several processes, each with several keep-alive connections, publish trails `start` to `start + count - 1` through the
public API. It writes `targets.json` (a sample of trail ids and fingerprints) for bench/load/load.js and prints the
rate as it goes. The colony enriches in the background: `wait` below (or `GET /v1/stats`, field `trails`) says when
every trail has been indexed.

Run it against a colony with MYRMO_RATE_LIMIT=0 and MYRMO_PUBLISH_LIMIT=0 (bench/scale/compose.yml sets both); never
against a production colony.
"""

from __future__ import annotations

import argparse
import http.client
import json
import multiprocessing as mp
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import make_trail  # noqa: E402

HERE = Path(__file__).resolve().parent
LOAD_TARGETS = HERE.parents[0] / "load" / "targets.json"


def worker(args: tuple) -> tuple[int, int, list[tuple[str, str]]]:
    """Publish one stripe of trails. Returns (published, failed, a sample of (trail id, fingerprint))."""
    base, indexes, threads, seed, collapsing, sample_every = args
    url = urlparse(base)
    local = []
    failed = 0

    def one(i: int):
        nonlocal failed
        body = json.dumps(make_trail(i, seed, collapsing)).encode()
        headers = {"content-type": "application/json", "x-myrmo-agent": f"bench_scale_{i % 97:03d}"}
        for attempt in range(6):
            try:
                conn = conns.get()
                try:
                    conn.request("POST", "/v1/trails", body=body, headers=headers)
                    res = conn.getresponse()
                    data = res.read()
                finally:
                    conns.put(conn)
                if res.status == 202:
                    out = json.loads(data)
                    return i, out["trail_id"], out["fingerprint"]
                if res.status in (429, 502, 503, 504):
                    time.sleep(0.5 * (attempt + 1))
                    continue
                break
            except (OSError, http.client.HTTPException):
                time.sleep(0.5 * (attempt + 1))
        failed += 1
        return None

    import queue

    conns: queue.Queue = queue.Queue()
    for _ in range(threads):
        conns.put(http.client.HTTPConnection(url.hostname, url.port or 80, timeout=60))
    done = 0
    with ThreadPoolExecutor(max_workers=threads) as pool:
        for result in pool.map(one, indexes):
            if result:
                done += 1
                if result[0] % sample_every == 0:
                    local.append((result[1], result[2]))
    return done, failed, local


def stats(base: str) -> dict:
    url = urlparse(base)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=30)
    conn.request("GET", "/v1/stats")
    return json.loads(conn.getresponse().read())


def wait_until_indexed(base: str, target: int, poll: float = 5.0, patience: float = 90.0) -> int:
    """Block until the colony reports at least `target` trails, printing the rate of enrichment. Gives up when the count
    has not moved for `patience` seconds: a trail that repeats an existing solution is merged, not counted, so the
    target is an upper bound. Returns the count reached."""
    last, last_t = stats(base).get("trails", 0), time.time()
    start, start_n, moved_t = last_t, last, last_t
    while last < target:
        time.sleep(poll)
        now = stats(base).get("trails", 0)
        t = time.time()
        print(f"  indexed {now}/{target}  ({(now - last) / (t - last_t):.0f}/s now, {(now - start_n) / (t - start):.0f}/s overall)", flush=True)
        if now > last:
            moved_t = t
        elif t - moved_t > patience:
            print(f"  no progress for {patience:.0f}s: {target - now} trails were merged into existing ones or are still waiting")
            return now
        last, last_t = now, t
    return last


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8080")
    ap.add_argument("count", type=int, nargs="?", default=100_000)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--threads", type=int, default=16, help="connections per process")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--collapsing", action="store_true", help="the families whose names the fingerprint replaces by a placeholder")
    ap.add_argument("--sample", type=int, default=5000, help="how many trails to keep as targets for the load test")
    ap.add_argument("--wait", action="store_true", help="after publishing, wait until the colony has indexed everything")
    ap.add_argument("--targets", default=str(LOAD_TARGETS))
    args = ap.parse_args()

    before = stats(args.base).get("trails", 0)
    sample_every = max(1, args.count // args.sample)
    chunk = 2000
    stripes = [(args.base, range(s, min(s + chunk, args.start + args.count)), args.threads, args.seed, args.collapsing, sample_every)
               for s in range(args.start, args.start + args.count, chunk)]
    start = time.time()
    published = failed = 0
    sample: list[tuple[str, str]] = []
    with mp.Pool(args.procs) as pool:
        for n, (done, bad, local) in enumerate(pool.imap_unordered(worker, stripes), 1):
            published += done
            failed += bad
            sample += local
            if n % max(1, len(stripes) // 20) == 0 or n == len(stripes):
                print(f"published {published}/{args.count}  ({published / (time.time() - start):.0f}/s)  failed {failed}", flush=True)
    print(f"published {published} trails in {time.time() - start:.0f}s ({published / (time.time() - start):.0f}/s), {failed} failed")
    if sample:
        random.Random(0).shuffle(sample)
        Path(args.targets).write_text(json.dumps({"trail_ids": [t for t, _ in sample], "fingerprints": [f for _, f in sample]}), encoding="utf-8")
        print(f"{len(sample)} targets in {args.targets}")
    if args.wait:
        wait_until_indexed(args.base, before + published)
        print(f"indexed everything {time.time() - start:.0f}s after the first request")


if __name__ == "__main__":
    main()
