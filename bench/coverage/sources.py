"""Check that each probe's source exists, says what the probe claims and has a licence the project can build on.

    python bench/coverage/sources.py

Writes sources-checked.json. A probe whose source cannot be fetched, lacks its phrase or has a licence outside the
policy (tools/seed-factory/provenance.py) is listed with the reason: it cannot be used as a candidate or in the
coverage set.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "tools/seed-factory"))
from capture import all_probes  # noqa: E402
import provenance  # noqa: E402


def check(probe) -> dict:
    result = {"id": probe.id, "url": probe.source_url, "licence": probe.source_licence}
    if not provenance.licence_allowed(probe.source_licence):
        return {**result, "ok": False, "why": f"licence {probe.source_licence} is not one the project can pass on"}
    try:
        req = urllib.request.Request(probe.source_url, headers={"user-agent": "myrmo-coverage/1.0"})
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read(8_000_000).decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError) as err:
        return {**result, "ok": False, "why": f"cannot fetch the source: {err}"}
    if probe.source_phrase.lower() not in text.lower():
        return {**result, "ok": False, "why": f"the source does not contain {probe.source_phrase!r}"}
    return {**result, "ok": True}


def main() -> int:
    probes = [p for p in all_probes() if (HERE / "captures" / f"{p.id}.json").exists()]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(check, probes))
    (HERE / "sources-checked.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    for r in results:
        if not r["ok"]:
            print(f"FAIL {r['id']}: {r['why']}")
    print(f"{sum(r['ok'] for r in results)} of {len(results)} sources verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
