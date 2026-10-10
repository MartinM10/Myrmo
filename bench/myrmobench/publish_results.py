"""Publish a real MyrmoBench run to the website.

    python bench/myrmobench/publish_results.py bench/results/myrmobench-20261101-1200

Reads runs.jsonl and environment.json of the run, and fills the `value` section of web/assets/bench-results.js, keeping
the load results already there. It refuses a run that has no follower runs with and without Myrmo: the website shows only
numbers somebody measured. The `unseen` condition (Myrmo connected to a colony that does not know the task) is
published too when the run has it.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import ROOT, summarize  # noqa: E402

SITE = ROOT / "web/assets/bench-results.js"


def value_section(run_dir: Path) -> dict:
    runs = [json.loads(line) for line in (run_dir / "runs.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    env = json.loads((run_dir / "environment.json").read_text(encoding="utf-8"))
    summary = summarize(runs)
    if not {"without", "with"} <= set(summary):
        raise SystemExit("The run has no follower runs both with and without Myrmo: nothing to publish.")
    conditions = env["plan"].get("conditions", ["without", "with"])
    section = {
        "run_id": run_dir.name,
        "date": run_dir.name.split("-")[1][:4] + "-" + run_dir.name.split("-")[1][4:6] + "-" + run_dir.name.split("-")[1][6:8],
        "agent": env.get("agent", "claude-code"),
        "pioneer": env["pioneer"],
        "followers": env["followers"],
        "tasks": sorted({r["task"] for r in runs}),
        "repetitions": env["plan"]["by_role"]["followers"][env["followers"][0]] // (len(conditions) * env["plan"]["tasks"]),
        "colony_trails_at_start": (env.get("colony_at_start") or {}).get("trails"),
        "pioneers_published": sum(bool(r.get("published")) for r in runs if r["role"] == "pioneer"),
    }
    for condition in ("without", "unseen", "with"):
        if condition in summary:
            section[condition] = {k: v for k, v in summary[condition].items() if k != "runs"}
    return section


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run_dir = Path(sys.argv[1]).resolve()
    section = value_section(run_dir)
    current = SITE.read_text(encoding="utf-8")
    match = re.search(r"window\.MYRMO_BENCH = (.*);\s*$", current, re.S)
    data = json.loads(match.group(1)) if match else {}
    data["value"] = section
    header = current.split("window.MYRMO_BENCH")[0]
    SITE.write_text(header + "window.MYRMO_BENCH = " + json.dumps(data, indent=2) + ";\n", encoding="utf-8")
    print(f"published {section['run_id']} to {SITE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
