"""Print the Redis commands that bring the "trails laid" counters of a colony back to what is alive.

Before removed trails were taken back from the per-model counters, every trail ever laid stayed counted. The public
"Models that solved things" figure therefore added up to more trails than the colony holds. New removals correct
the counters by themselves; this tool corrects the past. It changes nothing: it prints the commands, to be reviewed and
run by the operator against the colony's Valkey (for example `docker compose exec valkey valkey-cli`).

    MYRMO_ADMIN_TOKEN=... python tools/reconcile-laid.py https://myrmo.dev [--days 365]

It needs the operator token for `GET /v1/analytics` (it is only sent there) and reads the public feed, which holds
every live trail. For each model label it compares the trails laid, per the counters, with the trails alive, and takes
the difference off the newest days that have any. Models are labelled as the counters label them: the model a trail
declared, lower-cased, and `seed` for a trail of the project's own seed framework laid after seeds had a label of
their own; a seed laid before that is counted under the model it declared.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request


def get(base: str, path: str, token: str | None = None) -> dict:
    req = urllib.request.Request(base + path, headers={"accept": "application/json", "user-agent": "myrmo-reconcile/1.0"})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def label(value: object) -> str | None:
    """The counters' own rule for a model or framework name (`analytics::clean_label`)."""
    text = str(value or "").strip().lower()
    return text if text and len(text) <= 64 and text != "unknown" and re.fullmatch(r"[a-z0-9._:/@+-]+", text) else None


def live_by_label(base: str) -> dict[str, int]:
    live: dict[str, int] = {}
    cursor = None
    while True:
        query = {"limit": "50", **({"cursor": cursor} if cursor else {})}
        page = get(base, "/v1/feed?" + urllib.parse.urlencode(query))
        for item in page["items"]:
            model = label(item["trail"]["agent_info"].get("model"))
            if model:
                live[model] = live.get(model, 0) + 1
        cursor = page.get("next_cursor")
        if not cursor:
            return live


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", help="the colony, for example https://myrmo.dev")
    parser.add_argument("--days", type=int, default=365)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    token = os.environ.get("MYRMO_ADMIN_TOKEN")
    if not token:
        print("Set MYRMO_ADMIN_TOKEN to the colony's operator token.", file=sys.stderr)
        return 2
    live = live_by_label(base)
    days = get(base, f"/v1/analytics?days={args.days}", token)["days"]  # newest first
    laid: dict[str, int] = {}
    for day in days:
        for model, counters in day["models"].items():
            laid[model] = laid.get(model, 0) + int(counters.get("laid", 0))
    print(f"# live trails by model: {json.dumps(live, sort_keys=True)}")
    print(f"# counted as laid:      {json.dumps(laid, sort_keys=True)}")
    commands = []
    for model, counted in sorted(laid.items()):
        excess = counted - live.get(model, 0)
        for day in days:
            if excess <= 0:
                break
            here = int(day["models"].get(model, {}).get("laid", 0))
            take = min(here, excess)
            if take > 0:
                stamp = day["date"].replace("-", "")
                commands.append(f"HINCRBY an:d:{stamp} laid|{model} -{take}")
                commands.append(f"HINCRBY an:d:{stamp} trails -{take}")
                excess -= take
    if not commands:
        print("# nothing to correct")
    for command in commands:
        print(command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
