"""Print a weekly summary of how a colony is used: searches, how many were answered, agents, and what agents laid.

Reads the operator analytics (`GET /v1/analytics`, which only the operator token can call) and changes nothing.
Seeds and the project's own checks (`live-check`, `synthetic`) are left out of the "field" columns, so the numbers
show what real agents did.

    MYRMO_ADMIN_TOKEN=... python tools/weekly-report.py https://myrmo.dev [--weeks 6]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date

NOT_FIELD = {"seed", "seed-factory", "live-check", "synthetic", "test"}


def get(base: str, path: str, token: str) -> dict:
    req = urllib.request.Request(
        base + path,
        headers={"accept": "application/json", "user-agent": "myrmo-weekly/1.0", "authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def week_of(iso: str) -> str:
    year, week, _ = date.fromisoformat(iso).isocalendar()
    return f"{year}-W{week:02d}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", help="the colony, for example https://myrmo.dev")
    parser.add_argument("--weeks", type=int, default=6)
    args = parser.parse_args()
    token = os.environ.get("MYRMO_ADMIN_TOKEN")
    if not token:
        print("Set MYRMO_ADMIN_TOKEN to the colony's operator token.", file=sys.stderr)
        return 2
    days = get(args.base.rstrip("/"), f"/v1/analytics?days={args.weeks * 7}", token)["days"]
    weeks: dict[str, dict[str, int]] = {}
    for day in days:
        w = weeks.setdefault(week_of(day["date"]), dict.fromkeys(
            ("searches", "answered", "agents_peak", "laid", "worked", "failed", "seeds"), 0))
        totals = day["totals"]
        w["searches"] += int(totals.get("searches", 0))
        w["answered"] += int(totals.get("search_hits", 0))
        w["agents_peak"] = max(w["agents_peak"], int(day.get("agents_active", 0)))
        for model, c in day["models"].items():
            if model in NOT_FIELD:
                w["seeds"] += int(c.get("laid", 0)) if model.startswith("seed") else 0
                continue
            w["laid"] += int(c.get("laid", 0))
            w["worked"] += int(c.get("worked", 0)) + int(c.get("partially_worked", 0))
            w["failed"] += int(c.get("failed", 0))
    print(f"{'week':9} {'searches':>8} {'answered':>8} {'rate':>5} {'agents/day max':>14} {'laid':>5} {'worked':>6} {'failed':>6}")
    for name in sorted(weeks):
        w = weeks[name]
        rate = f"{100 * w['answered'] // w['searches']}%" if w["searches"] else "-"
        print(f"{name:9} {w['searches']:>8} {w['answered']:>8} {rate:>5} {w['agents_peak']:>14} "
              f"{w['laid']:>5} {w['worked']:>6} {w['failed']:>6}")
    print("\nlaid/worked/failed: real models only (seeds, live-check, synthetic and test are left out).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
