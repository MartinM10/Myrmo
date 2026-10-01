"""Fill a colony with synthetic trails for load testing.

    python bench/load/populate.py http://localhost:8080 100000

Variants of the seed trails with randomised identifiers, so every trail gets its own
fingerprint. Published through the public API with 32 concurrent workers. Writes the
fingerprints and ids it created to bench/load/targets.json for the k6 scenarios.
Run it against a colony with MYRMO_RATE_LIMIT=0; never against a production colony.
"""

from __future__ import annotations

import copy
import json
import random
import string
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 100_000
ROOT = Path(__file__).resolve().parents[2]
SEEDS = json.loads((ROOT / "deploy/seed/trails.json").read_text(encoding="utf-8"))
OUT = Path(__file__).with_name("targets.json")

WORDS = ["alpha", "beacon", "cobalt", "delta", "ember", "falcon", "garnet", "harbor", "indigo", "juniper",
         "kepler", "lumen", "matrix", "nimbus", "onyx", "prism", "quartz", "raven", "sierra", "tundra"]


def variant(i: int) -> dict:
    rnd = random.Random(i)
    t = copy.deepcopy(SEEDS[i % len(SEEDS)])
    # Letters only: identifiers mixing letters and digits are normalised away by the
    # fingerprint (as request ids should be), which would collapse the variants.
    token = "-".join(WORDS[(i // 20 ** k) % 20] for k in range(4))
    msg = t["problem"].get("error_message") or t["problem"]["error_type"]
    t["problem"]["error_message"] = f"{msg} [{token}]"[:1000]
    t["problem"]["summary"] = f"{t['problem']['summary']} Seen in component {token}."[:1000]
    t["environment"]["runtime"]["version"] = f"{rnd.randint(1, 30)}.{rnd.randint(0, 40)}.{rnd.randint(0, 9)}"
    t["agent_info"] = {"model": "synthetic", "framework": "myrmo-bench"}
    t["tags"] = ["synthetic", "bench"]
    return t


def publish(i: int) -> tuple[str, str] | None:
    body = json.dumps(variant(i)).encode()
    req = urllib.request.Request(BASE + "/v1/trails", data=body, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-myrmo-agent", f"bench_publisher_{i % 64:02d}")
    for _ in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                data = json.loads(res.read())
                return data["trail_id"], data["fingerprint"]
        except Exception:
            time.sleep(1)
    return None


def main() -> None:
    start = time.time()
    created: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=32) as pool:
        for n, result in enumerate(pool.map(publish, range(COUNT)), 1):
            if result:
                created.append(result)
            if n % 5000 == 0:
                print(f"{n}/{COUNT} published in {time.time() - start:.0f}s", flush=True)
    sample = random.Random(0).sample(created, min(5000, len(created)))
    OUT.write_text(json.dumps({"trail_ids": [t for t, _ in sample], "fingerprints": [f for _, f in sample]}), encoding="utf-8")
    print(f"published {len(created)} trails in {time.time() - start:.0f}s; targets in {OUT.name}")


if __name__ == "__main__":
    main()
