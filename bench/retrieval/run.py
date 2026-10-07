"""Retrieval benchmark: when an agent searches for an error, does Myrmo return the trail that solves it?

    docker compose -p myrmo-retrieval -f docker-compose.yml -f bench/compose.yml up -d gateway enricher valkey qdrant embed
    python bench/retrieval/run.py http://localhost:8080 --out bench/results/retrieval-YYYYMMDD

It publishes `corpus.jsonl` to an empty colony, then searches the way an agent does (the Python SDK: exact
fingerprint first, semantic search when that finds nothing) with:

  * positives: the error of a published trail as an agent on another machine would see it (paths, versions,
    ports and line numbers changed; wrapped in another exception; with a stack header; cut short; without its
    type prefix). Scored by whether the trail is returned, and where.
  * negatives: errors no trail covers, and look-alikes that name another module or key than a published trail,
    where the name decides the fix. The right answer is nothing; a trail returned is a wrong answer
    (`negatives.json` says which trails are fair answers to a negative, judged by hand).
  * a threshold sweep: the colony returns every semantic match above its similarity floor, so the stored
    scores show what a stricter floor would have found and what it would have stopped.

No agent and no model is involved, so a run takes about a minute and costs nothing. Never run it against a
production colony: it publishes the corpus and expects an empty one.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from myrmo import Colony
from myrmo.fingerprint import normalize_message

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LIMIT = 5

WRAPPERS = [
    "RuntimeError: Command failed: {m}",
    "npm error {m}",
    "ERROR: {m}",
    "Caused by: {m}",
    "java.util.concurrent.CompletionException: java.lang.IllegalStateException: {m}",
    "fatal: {m}",
]
STACK_HEADERS = [
    'Traceback (most recent call last):\n  File "/app/main.py", line 12, in <module>\n    main()\n{m}',
    "node:internal/process/promises:288\n            triggerUncaughtException(err, true /* fromPromise */);\n{m}\n    at Object.<anonymous> (/app/index.js:10:5)",
    "make: *** [Makefile:14: build] Error 1\n{m}",
]
PATHS = ["/home/dev/work/app/deploy.sh", "/workspace/service/src/main.c", "/opt/build/tmp/run.sh", "/Users/sam/projects/api/cmd/server"]


# -- variants ---------------------------------------------------------------------------


def shift(message: str, rnd: random.Random) -> str:
    """The same error on another machine: other paths, versions, ports, line numbers."""
    out = message.replace("<path>", rnd.choice(PATHS))
    out = re.sub(r"(?<=:)\d+(?=:\d+)", lambda m: str(rnd.randint(3, 400)), out)  # file:LINE:col
    out = re.sub(r"(?<=:)\d+\b", lambda m: str(rnd.randint(3, 400)) if int(m.group()) < 1000 else m.group(), out)
    out = re.sub(r"\b\d{4,5}\b", lambda m: str(rnd.randint(1024, 65000)), out)  # ports, pids
    out = re.sub(r"\b(\d+)\.(\d+)(?:\.(\d+))?\b", lambda m: f"{rnd.randint(1, 20)}.{rnd.randint(0, 30)}" + (f".{rnd.randint(0, 9)}" if m.group(3) else ""), out)
    return out


def truncate(message: str) -> str | None:
    words = message.split()
    if len(words) < 8:
        return None
    return " ".join(words[: max(5, math.ceil(len(words) * 0.6))])


def strip_type(message: str, error_type: str) -> str | None:
    head = message.split(":", 1)[0]
    if ":" in message and " " not in head and len(head) <= 64:
        return message.split(":", 1)[1].strip() or None
    return None


def positives(trail: dict, rnd: random.Random):
    """(variant name, query text, runtime version) for one trail."""
    p, env = trail["problem"], trail["environment"]
    message = (p.get("error_message") or p["error_type"]).strip()
    version = env["runtime"]["version"]
    yield "exact", message, version
    yield "shifted", shift(message, rnd), f"{rnd.randint(1, 20)}.{rnd.randint(0, 30)}.{rnd.randint(0, 9)}"
    yield "wrapped", rnd.choice(WRAPPERS).format(m=shift(message, rnd)), version
    yield "stack_header", rnd.choice(STACK_HEADERS).format(m=shift(message, rnd)), version
    cut = truncate(message)
    if cut:
        yield "truncated", cut, version
    bare = strip_type(message, p["error_type"])
    if bare and len(bare.split()) >= 3:
        yield "no_type_prefix", bare, version


# -- colony -----------------------------------------------------------------------------


def http(base: str, method: str, path: str, body=None, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("x-myrmo-agent", "bench_retrieval_publisher")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def publish_corpus(base: str, rows: list[dict]) -> dict[int, str]:
    ids: dict[int, str] = {}
    for i, row in enumerate(rows):
        status, data = http(base, "POST", "/v1/trails", row["trail"])
        if status != 202:
            sys.exit(f"corpus trail {i} was not accepted: HTTP {status} {data}")
        ids[i] = data["trail_id"]
    final: dict[int, str] = {}
    deadline = time.time() + 300
    for i, tid in ids.items():
        while True:
            _, data = http(base, "GET", f"/v1/trails/{tid}")
            if data.get("status") not in (None, "queued", "pending", "processing"):
                break
            if time.time() > deadline:
                sys.exit("timed out waiting for the colony to index the corpus")
            time.sleep(0.5)
        if data["status"] != "indexed":
            sys.exit(f"corpus trail {i} ended as {data['status']}: {data.get('reasons')}")
        final[i] = data.get("merged_into") or tid
    return final


# -- scoring ----------------------------------------------------------------------------

FLOORS = [0.72, 0.75, 0.78, 0.80, 0.85]  # 0.72 is the colony's default (MYRMO_MIN_SIMILARITY)


def words(message: str) -> int:
    return len(message.split())


def hits_of(result, judge) -> list[dict]:
    return [{"ok": judge(h), "score": h.match.get("score"), "via": h.match.get("via")} for h in result.hits[:LIMIT]]


def rank_of(hits: list[dict]) -> int | None:
    return next((pos for pos, h in enumerate(hits, 1) if h["ok"]), None)


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "-"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8080")
    ap.add_argument("--out", default=str(ROOT / "bench" / "results" / "retrieval-dev"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--allow-nonempty", action="store_true")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    status, stats = http(base, "GET", "/v1/stats")
    if status == 200 and stats.get("trails", 0) and not args.allow_nonempty:
        sys.exit(f"the colony already holds {stats['trails']} trails; run against an empty one (docker compose down -v)")

    rows = [json.loads(line) for line in (HERE / "corpus.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    spec = json.loads((HERE / "negatives.json").read_text(encoding="utf-8"))
    ids = publish_corpus(base, rows)

    error_type_of = {ids[i]: rows[i]["trail"]["problem"]["error_type"] for i in ids}
    # Trails whose message normalises to the same text answer each other's questions: one is as good as the other.
    groups: dict[str, set[str]] = defaultdict(set)
    for i, row in enumerate(rows):
        p = row["trail"]["problem"]
        groups[normalize_message(p["error_type"], p.get("error_message") or p["error_type"])].add(ids[i])

    colony = Colony(url=base, agent_id="bench_retrieval_0001", cache_ttl=0, retries=0, timeout=60)

    def ask(kind, variant, query, runtime, version, judge, **extra):
        t0 = time.perf_counter()
        result = colony.search(query, runtime=runtime, runtime_version=version, limit=LIMIT)
        hits = hits_of(result, judge)
        return {"kind": kind, "variant": variant, "query": query, "source": result.source, "hits": hits, "rank": rank_of(hits),
                "seconds": round(time.perf_counter() - t0, 4), **extra}

    records: list[dict] = []
    for i, row in enumerate(rows):
        trail = row["trail"]
        p = trail["problem"]
        message = (p.get("error_message") or p["error_type"]).strip()
        acceptable = groups[normalize_message(p["error_type"], message)] | {ids[i]}
        rnd = random.Random(f"{args.seed}:{i}")
        for variant, query, version in positives(trail, rnd):
            records.append(ask("positive", variant, query, trail["environment"]["runtime"]["name"], version,
                               lambda h: h.trail_id in acceptable, trail=i, error_type=p["error_type"], bare=words(message) < 3))
    for q in spec["queries"]:
        related = set(q.get("related", []))
        records.append(ask("negative", "unrelated", q["error"], q.get("runtime"), None, lambda h: error_type_of.get(h.trail_id) in related))
    for q in spec["lookalikes"]:
        avoid = set(q["avoid"])
        records.append(ask("negative", "lookalike", q["error"], q.get("runtime"), None, lambda h: error_type_of.get(h.trail_id) not in avoid))

    summary = summarise(records)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "retrieval-results.json").write_text(json.dumps({"seed": args.seed, "corpus_trails": len(rows), "summary": summary, "records": records}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    text = render(summary, len(rows), args.seed)
    (out / "retrieval-summary.md").write_text(text, encoding="utf-8")
    print(text)
    print(f"raw results: {out}")


def after_floor(record: dict, floor: float) -> list[dict]:
    """The hits the colony would have returned with a stricter similarity floor (exact fingerprint hits are not filtered)."""
    if record["source"] != "search":
        return record["hits"]
    return [h for h in record["hits"] if h["via"] != "semantic" or (h["score"] or 0) >= floor]


def summarise(records: list[dict]) -> dict:
    positives = [r for r in records if r["kind"] == "positive"]
    main_set = [r for r in positives if not r["bare"]]
    by_variant: dict[str, dict] = {}
    for variant in dict.fromkeys(r["variant"] for r in main_set):
        rs = [r for r in main_set if r["variant"] == variant]
        ranks = [r["rank"] for r in rs]
        by_variant[variant] = {
            "n": len(rs),
            "recall@1": sum(1 for x in ranks if x == 1) / len(rs),
            "recall@3": sum(1 for x in ranks if x and x <= 3) / len(rs),
            "mrr": sum(1 / x for x in ranks if x) / len(rs),
            "wrong_top1": sum(1 for r in rs if r["hits"] and not r["hits"][0]["ok"]) / len(rs),
            "via": dict(Counter(r["source"] for r in rs)),
            "p50_ms": round(1000 * statistics.median(r["seconds"] for r in rs), 1),
        }
    bare = [r for r in positives if r["bare"]]

    def negative(variant: str) -> dict:
        rs = [r for r in records if r["kind"] == "negative" and r["variant"] == variant]
        wrong = [r for r in rs if any(not h["ok"] for h in r["hits"][:1])]
        return {"n": len(rs), "returned_any": sum(1 for r in rs if r["hits"]), "wrong_answers": len(wrong), "wrong_queries": [r["query"] for r in wrong]}

    sweep = []
    for floor in FLOORS:
        pos = [r for r in main_set if r["source"] == "search"]  # only semantic answers move with the floor
        found = sum(1 for r in pos if (h := after_floor(r, floor)) and h[0]["ok"])
        wrong_pos = sum(1 for r in pos if (h := after_floor(r, floor)) and not h[0]["ok"])
        neg = [r for r in records if r["kind"] == "negative"]
        wrong_neg = sum(1 for r in neg if (h := after_floor(r, floor)) and not h[0]["ok"])
        sweep.append({"floor": floor, "semantic_positives": len(pos), "found": found, "wrong_on_positives": wrong_pos, "negatives": len(neg), "wrong_on_negatives": wrong_neg})
    return {"positives": by_variant, "bare_messages": {"n": len(bare), "found": sum(1 for r in bare if r["rank"]), "trails": len({r["trail"] for r in bare})},
            "unrelated": negative("unrelated"), "lookalike": negative("lookalike"), "floor_sweep": sweep}


def render(summary: dict, corpus: int, seed: int) -> str:
    lines = [f"Retrieval benchmark: {corpus} published trails, seed {seed}, up to {LIMIT} results per search.", "",
             "| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |", "|---|---|---|---|---|---|---|---|"]
    for name, v in summary["positives"].items():
        via = ", ".join(f"{k} {n}" for k, n in sorted(v["via"].items()))
        lines.append(f"| {name} | {v['n']} | {100 * v['recall@1']:.0f}% | {100 * v['recall@3']:.0f}% | {v['mrr']:.2f} | {100 * v['wrong_top1']:.0f}% | {via} | {v['p50_ms']} ms |")
    b = summary["bare_messages"]
    lines += ["", f"{b['trails']} corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in {b['found']} of {b['n']}.",
              "", "| Should find nothing | Searches | Returned a trail | Wrong answers |", "|---|---|---|---|"]
    for label, key in (("Errors no trail covers", "unrelated"), ("Look-alikes (another module or key)", "lookalike")):
        w = summary[key]
        lines.append(f"| {label} | {w['n']} | {w['returned_any']} | {w['wrong_answers']} ({pct(w['wrong_answers'], w['n'])}) |")
    lines += ["", "What a stricter similarity floor would have done with the same searches (semantic answers only; the colony's default is 0.72):", "",
              "| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |", "|---|---|---|---|"]
    for s in summary["floor_sweep"]:
        lines.append(f"| {s['floor']:.2f} | {s['found']} of {s['semantic_positives']} | {s['wrong_on_positives']} | {s['wrong_on_negatives']} of {s['negatives']} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
