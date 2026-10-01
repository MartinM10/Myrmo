"""Publish a k6 load summary to the website.

    python bench/load/publish_results.py "Docker Desktop, 12 vCPU (Intel Core i7-12700H)" 12

Reads bench/results/load-summary.json (written by load.js), archives it under
bench/results/<run_id>/ and updates the `load` section of web/assets/bench-results.js,
keeping any MyrmoBench (`value`) results already published.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUMMARY = ROOT / "bench/results/load-summary.json"
SITE = ROOT / "web/assets/bench-results.js"


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    hardware, vcpus = sys.argv[1], int(sys.argv[2])
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    run_id = "load-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")

    archive = ROOT / "bench/results" / run_id
    archive.mkdir(parents=True, exist_ok=True)
    shutil.copy(SUMMARY, archive / "load-summary.json")
    (archive / "environment.json").write_text(json.dumps({"hardware": hardware, "vcpus": vcpus}, indent=2), encoding="utf-8")

    current = SITE.read_text(encoding="utf-8")
    match = re.search(r"window\.MYRMO_BENCH = (.*);\s*$", current, re.S)
    data = json.loads(match.group(1)) if match and match.group(1).strip() != "null" else {}
    data = data or {}
    data["load"] = {
        "run_id": run_id,
        "date": summary["date"],
        "hardware": f"{hardware}, whole stack on one machine, {summary['vus']} virtual users",
        "scenarios": [
            {
                "name": s["name"],
                "rps": round(s["rps"], 1),
                "rps_per_vcpu": round(s["rps"] / vcpus, 1),
                "p50_ms": round(s["p50_ms"], 2),
                "p99_ms": round(s["p99_ms"], 2),
                "error_rate": s["error_rate"],
            }
            for s in summary["scenarios"]
        ],
    }
    data.setdefault("value", None)
    header = current.split("window.MYRMO_BENCH")[0]
    SITE.write_text(header + "window.MYRMO_BENCH = " + json.dumps(data, indent=2) + ";\n", encoding="utf-8")
    print(f"published {run_id} to {SITE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
