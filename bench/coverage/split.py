"""Build lines.jsonl from the captures and split it, at random, into `candidate` and `reserved`.

    python bench/coverage/split.py

Candidates may be turned into tasks for the seed factory. The reserved half never is: coverage is measured on it,
because a colony measured on the errors it was built from says nothing about errors it has not seen. The split is
stratified by ecosystem and drawn from a fixed seed, and it is written down once: an id that already has a split keeps it. Once the
reserved half has RESERVED_TARGET lines, new lines go to the candidates.
"""

from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "protocol"))
from capture import all_probes  # noqa: E402
from fingerprint_v2 import fingerprint  # noqa: E402

SEED = 20261008
#: Coverage is measured on the reserved half, which needs a sample big enough to say something. Once it holds this many lines, new
#: lines go to the candidates (more trails), not to the measurement.
RESERVED_TARGET = 45
LINES = HERE / "lines.jsonl"


def main() -> int:
    kept = {}
    if LINES.exists():
        kept = {row["id"]: row for row in map(json.loads, LINES.read_text(encoding="utf-8").splitlines() if LINES.read_text(encoding="utf-8").strip() else [])}
    checked = {r["id"]: r for r in json.loads((HERE / "sources-checked.json").read_text(encoding="utf-8"))}
    rows, new = [], defaultdict(list)
    for probe in all_probes():
        capture = HERE / "captures" / f"{probe.id}.json"
        source = checked.get(probe.id)
        if not capture.exists() or not source or not source["ok"]:
            continue
        data = json.loads(capture.read_text(encoding="utf-8"))
        row = {"id": probe.id, "ecosystem": probe.ecosystem, "error_line": data["error_line"], "versions": probe.versions,
               "source": {"url": probe.source_url, "licence": probe.source_licence}, "fingerprint": fingerprint(data["error_line"]),
               "must": list(probe.must), "split": kept.get(probe.id, {}).get("split")}
        rows.append(row)
        if row["split"] is None:
            new[probe.ecosystem].append(row)
    rng = random.Random(SEED)
    # Within an ecosystem the new ids are shuffled and dealt out alternately, so each half has about the same mix. The
    # first card of an odd pile goes to whichever half has fewer.
    counts = {"candidate": sum(r["split"] == "candidate" for r in rows), "reserved": sum(r["split"] == "reserved" for r in rows)}
    for eco in sorted(new):
        pile = sorted(new[eco], key=lambda r: r["id"])
        rng.shuffle(pile)
        for i, row in enumerate(pile):
            half = "candidate" if i % 2 == 0 else "reserved"
            if len(pile) % 2 == 1 and i == 0:
                half = min(counts, key=counts.get)
            if counts["reserved"] >= RESERVED_TARGET:
                half = "candidate"
            row["split"] = half
            counts[half] += 1
    LINES.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in sorted(rows, key=lambda r: r["id"])), encoding="utf-8")
    per = defaultdict(lambda: {"candidate": 0, "reserved": 0})
    for r in rows:
        per[r["ecosystem"]][r["split"]] += 1
    print(json.dumps({"lines": len(rows), "per_ecosystem": per, "totals": counts}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
