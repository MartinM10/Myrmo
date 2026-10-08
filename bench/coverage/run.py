"""How likely is it that an agent that hits one of these errors finds a trail that solves it?

    python bench/coverage/run.py --base http://localhost:8080 [--split reserved] [--out bench/results/coverage-<id>]

Every line is searched the way an agent does it with the SDK: the exact fingerprint first, the semantic search second.
What came back is judged against the line's rubric (`must`: patterns that the text of a trail has to match, all of them).
Four outcomes:

  hit             a trail that solves the line came back
  miss            a trail that solves it exists in the colony, but did not come back
  false_positive  trails came back, none of them solves it, and none exists in the colony that does
  silence         nothing came back, and nothing in the colony solves it (the right answer to "no trail")

A trail that matches some patterns but not all is `dubious`: it is listed apart for a person to read, and counted as
not solving until someone decides otherwise. The rubric ground truth is the whole colony, read from its feed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "clients/python/src"))


def trail_text(trail: dict) -> str:
    p, s = trail.get("problem", {}), trail.get("solution", {})
    parts = [p.get("error_type", ""), p.get("error_message", ""), p.get("summary", ""), s.get("root_cause", ""), *s.get("steps", [])]
    parts += [c.get("command", "") for c in s.get("shell_commands_executed", [])]
    parts += [a.get("approach", "") for a in p.get("failed_approaches", [])]
    return "\n".join(str(x) for x in parts)


def judge(text: str, must: list[str]) -> str:
    """`solves` when every pattern matches, `partial` when some do, `no` otherwise."""
    found = [bool(re.search(m, text, re.I)) for m in must]
    return "solves" if found and all(found) else "partial" if any(found) else "no"


def colony_trails(base: str) -> list[dict]:
    items, cursor = [], None
    while True:
        query = {"limit": "50", **({"cursor": str(cursor)} if cursor else {})}
        req = urllib.request.Request(f"{base}/v1/feed?{urllib.parse.urlencode(query)}", headers={"user-agent": "myrmo-coverage/1.0"})
        page = json.loads(urllib.request.urlopen(req, timeout=60).read())
        items += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return items


def classify(line: dict, hits: list, corpus: list[dict]) -> tuple[str, list[dict]]:
    must = line["must"]
    graded = [(h, judge(trail_text(h.trail), must)) for h in hits]
    dubious = [{"trail_id": h.trail_id, "error": h.trail["problem"]["error_message"][:120]} for h, g in graded if g == "partial"]
    if any(g == "solves" for _, g in graded):
        return "hit", dubious
    exists = any(judge(trail_text(i["trail"]), must) == "solves" for i in corpus)
    if exists:
        return "miss", dubious
    return ("false_positive" if hits else "silence"), dubious


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8080")
    parser.add_argument("--split", default="reserved", choices=["reserved", "candidate", "all"])
    parser.add_argument("--out")
    args = parser.parse_args()
    from myrmo import Colony

    lines = [json.loads(x) for x in (HERE / "lines.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    lines = [l for l in lines if args.split == "all" or l["split"] == args.split]
    corpus = colony_trails(args.base)
    colony = Colony(url=args.base, agent_id=False)
    rows, dubious = [], []
    for line in lines:
        runtime = line["versions"].get("python") and "python" or None
        result = colony.search(line["error_line"], runtime=runtime)
        outcome, doubt = classify(line, list(result.hits), corpus)
        rows.append({"id": line["id"], "ecosystem": line["ecosystem"], "outcome": outcome, "via": result.source, "returned": len(result.hits)})
        dubious += [{"line": line["id"], **d} for d in doubt]
    per = defaultdict(lambda: defaultdict(int))
    for r in rows:
        per[r["ecosystem"]][r["outcome"]] += 1
        per["all"][r["outcome"]] += 1
    summary = {"split": args.split, "lines": len(rows), "colony_trails": len(corpus),
               "per_ecosystem": {k: dict(v) for k, v in sorted(per.items())}}
    total = max(1, len(rows))
    summary["hit_rate"] = round(per["all"]["hit"] / total, 3)
    summary["false_positive_rate"] = round(per["all"]["false_positive"] / total, 3)
    summary["silence_rate"] = round(per["all"]["silence"] / total, 3)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "coverage.json").write_text(json.dumps({"summary": summary, "rows": rows, "dubious": dubious}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    if dubious:
        print(f"\n{len(dubious)} dubious matches to read by hand:")
        for d in dubious[:20]:
            print(f"  {d['line']}: {d['trail_id'][:8]} {d['error']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
