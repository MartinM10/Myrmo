"""Can a search still find one trail among many, and does it stay quiet when there is none?

    python bench/scale/needles.py http://localhost:8080 --size 1000000

Run it after bench/scale/populate.py has filled the colony with trails 0 to size-1 (same --seed). It asks the way an
agent does (the Python SDK: fingerprint lookup first, semantic search when that finds nothing) about:

  * needles: trails picked at random among the first `size`, searched by their message as published, wrapped in
    another exception and without their exception class. A search succeeds when the trail it is about comes back,
    judged by its fingerprint, so no ledger of ids is needed.
  * strangers: the same kinds of error about names that were never published (trails numbered far beyond `size`).
    Every trail in the colony is about another name, so the right answer is nothing: whatever comes back is wrong.

Reported: how many needles were found and where, how many strangers got a trail (and through which path), and the
latency of each. Never run it against a production colony: it only reads, but it assumes the colony holds the haystack.
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

from myrmo import Colony, redact_text
from myrmo.fingerprint import fingerprint2, strip_labels

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import make_trail  # noqa: E402

LIMIT = 5
WRAPPERS = ["RuntimeError: Command failed: {m}", "ERROR: {m}", "Caused by: {m}", "java.util.concurrent.CompletionException: java.lang.IllegalStateException: {m}"]
STRANGER_BASE = 10_000_000_000  # trail numbers that no population run reaches


def variants(message: str, rnd: random.Random) -> dict[str, str]:
    """Searches that all still contain the name that tells this trail from its siblings. (Cutting the message short
    would drop it: among thousands of trails of one kind, the name is all that tells them apart.)"""
    out = {"as published": message, "wrapped": rnd.choice(WRAPPERS).format(m=message)}
    bare = strip_labels(message)
    if bare != message:
        out["without its class"] = bare
    return out


def pct(values: list[float], q: float) -> float:
    return sorted(values)[min(len(values) - 1, int(q * len(values)))] * 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8080")
    ap.add_argument("--size", type=int, required=True, help="how many trails the colony holds (numbers 0 to size-1)")
    ap.add_argument("--needles", type=int, default=1500)
    ap.add_argument("--strangers", type=int, default=1500)
    ap.add_argument("--seed", type=int, default=11, help="the seed given to populate.py")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    rnd = random.Random(f"needles:{args.size}")
    colony = Colony(url=args.base.rstrip("/"), agent_id="bench_needles_0001", cache_ttl=0, retries=0, timeout=60)

    records: list[dict] = []

    def ask(kind: str, variant: str, text: str, runtime: str, expected: str | None) -> None:
        t0 = time.perf_counter()
        result = colony.search(text, runtime=runtime, limit=LIMIT)
        seconds = time.perf_counter() - t0
        rank = None
        for pos, hit in enumerate(result.hits[:LIMIT], 1):
            # Judged by fingerprint, not by text: the colony redacts a trail when it files it (`password: YES` becomes
            # `password: <redacted:secret>`), so the stored message is not always the one that was published.
            if expected is not None and fingerprint2(hit.trail.get("problem", {}).get("error_message") or "") == expected:
                rank = pos
                break
        top = result.hits[0].match if result.hits else {}
        records.append({"kind": kind, "variant": variant, "source": result.source, "returned": len(result.hits), "rank": rank, "seconds": seconds,
                        "top_via": top.get("via"), "top_score": top.get("score")})

    for i in rnd.sample(range(args.size), args.needles):
        trail = make_trail(i, args.seed)
        message = trail["problem"]["error_message"]
        for variant, text in variants(message, rnd).items():
            ask("needle", variant, text, trail["environment"]["runtime"]["name"], fingerprint2(redact_text(message)))
    for j in range(args.strangers):
        trail = make_trail(STRANGER_BASE + j, args.seed)
        ask("stranger", "as published", trail["problem"]["error_message"], trail["environment"]["runtime"]["name"], None)

    needle_variants = list(dict.fromkeys(r["variant"] for r in records if r["kind"] == "needle"))
    print(f"colony of {args.size:,} trails, {args.needles} needles and {args.strangers} strangers, up to {LIMIT} results per search\n")
    print("| Needle searched by | Searches | Top 1 | Top 3 | Not found | Wrong trail on top | Answered by | p50 | p99 |\n|---|---|---|---|---|---|---|---|---|")
    summary = {"size": args.size, "needles": {}, "strangers": {}}
    for v in needle_variants:
        rs = [r for r in records if r["kind"] == "needle" and r["variant"] == v]
        n = len(rs)
        top1 = sum(1 for r in rs if r["rank"] == 1)
        top3 = sum(1 for r in rs if r["rank"] and r["rank"] <= 3)
        missing = sum(1 for r in rs if r["rank"] is None)
        wrong = sum(1 for r in rs if r["returned"] and r["rank"] != 1)
        via = Counter(r["source"] for r in rs)
        lat = [r["seconds"] for r in rs]
        summary["needles"][v] = {"n": n, "top1": top1 / n, "top3": top3 / n, "not_found": missing / n, "wrong_top": wrong / n, "via": dict(via), "p50_ms": statistics.median(lat) * 1000, "p99_ms": pct(lat, 0.99)}
        print(f"| {v} | {n} | {100 * top1 / n:.1f}% | {100 * top3 / n:.1f}% | {100 * missing / n:.1f}% | {100 * wrong / n:.1f}% | {', '.join(f'{k} {c}' for k, c in sorted(via.items()))} | {statistics.median(lat) * 1000:.1f} ms | {pct(lat, 0.99):.1f} ms |")
    rs = [r for r in records if r["kind"] == "stranger"]
    got = [r for r in rs if r["returned"]]
    via = Counter(r["source"] for r in got)
    lat = [r["seconds"] for r in rs]
    summary["strangers"] = {"n": len(rs), "returned_a_trail": len(got) / len(rs), "via": dict(via), "p50_ms": statistics.median(lat) * 1000, "p99_ms": pct(lat, 0.99)}
    print(f"\nStrangers (a name nobody published): {len(got)} of {len(rs)} ({100 * len(got) / len(rs):.1f}%) got a trail, every one of them wrong"
          f"{' (' + ', '.join(f'{k} {c}' for k, c in sorted(via.items())) + ')' if via else ''}; p50 {statistics.median(lat) * 1000:.1f} ms, p99 {pct(lat, 0.99):.1f} ms")
    if args.out:
        Path(args.out).write_text(json.dumps({"summary": summary, "records": records}, indent=1) + "\n", encoding="utf-8")
        print(f"raw results: {args.out}")


if __name__ == "__main__":
    main()
