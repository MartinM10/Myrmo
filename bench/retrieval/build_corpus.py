"""Collect the trails the retrieval benchmark publishes into one reproducible snapshot.

    python bench/retrieval/build_corpus.py

Reads the trails the seed factory made from commands it ran in disposable containers (`seed-out/*.jsonl`,
ignored by git) and the hand-made seed trails in `deploy/seed/trails.json`, keeps one trail per error and
writes `bench/retrieval/corpus.jsonl`. Every line records where the trail came from (`source`), so the
snapshot can be audited later. Rerun it only to change the corpus on purpose: the committed file is what
published results are measured against.
"""

from __future__ import annotations

import glob
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).with_name("corpus.jsonl")


def publishable(trail: dict) -> dict:
    """What the publisher sends: the factory's own bookkeeping (`_factory`, `fingerprint`) is not part of protocol v1."""
    return {k: v for k, v in trail.items() if not k.startswith("_") and k != "fingerprint"}


def key(trail: dict) -> tuple[str, str]:
    p = trail["problem"]
    return p["error_type"].lower(), re.sub(r"\s+", " ", (p.get("error_message") or "")).strip().lower()[:200]


def main() -> None:
    corpus: dict[tuple[str, str], dict] = {}

    for path in sorted(glob.glob(str(ROOT / "seed-out" / "*.jsonl"))):
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            trail = row.get("trail") or row
            if "problem" not in trail:
                continue  # publisher logs (fingerprint, trail_id, status) are not trails
            corpus.setdefault(key(trail), {"source": f"seed-factory:{Path(path).stem}", "trail": publishable(trail)})

    for trail in json.loads((ROOT / "deploy" / "seed" / "trails.json").read_text(encoding="utf-8")):
        corpus.setdefault(key(trail), {"source": "deploy-seed", "trail": publishable(trail)})

    rows = sorted(corpus.values(), key=lambda r: key(r["trail"]))
    OUT.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows), encoding="utf-8")
    by_source: dict[str, int] = {}
    for r in rows:
        by_source[r["source"].split(":")[0]] = by_source.get(r["source"].split(":")[0], 0) + 1
    print(f"{len(rows)} trails -> {OUT.relative_to(ROOT)}  {by_source}")


if __name__ == "__main__":
    main()
