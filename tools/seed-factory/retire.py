"""Take factory trails that should not be in the colony out of it (operator only).

By default it only prints what it would remove. Removing needs the operator token in the
MYRMO_ADMIN_TOKEN environment variable and the --yes flag. It talks to two endpoints only: the public
feed and DELETE /v1/trails/{id}. Run it from your own machine: the token never has to leave it.

  python tools/seed-factory/retire.py                  # list what the publication policy excludes
  python tools/seed-factory/retire.py --flawed         # also list trails with unusable placeholders
  MYRMO_ADMIN_TOKEN=... python tools/seed-factory/retire.py --flawed --yes
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "protocol"))
from catalog import POLICY_EXCLUDED  # noqa: E402
from fingerprint_v2 import fingerprint  # noqa: E402
from publisher import allowed  # noqa: E402

OUT = Path(os.environ.get("MYRMO_SEED_OUT", HERE.parents[1] / "seed-out"))
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UA = "myrmo-seed-factory/1.0"


def task_ids_by_fingerprint(seed_out: Path) -> dict[str, str]:
    """Which task made which trail, from the lots the factory wrote on this machine."""
    found: dict[str, str] = {}
    for name in glob.glob(str(seed_out / "*.jsonl")):
        if name.endswith("published.jsonl"):
            continue
        for line in Path(name).read_text(encoding="utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                if "fingerprint" in item and "_factory" in item:
                    task_id = item["_factory"]["task_id"]
                    found[item["fingerprint"]] = task_id
                    # Lots made before fp2 carry an fp1; the colony files trails under the fp2 of their message.
                    found[fingerprint(item["problem"]["error_message"])] = task_id
    return found


def flaws(trail: dict) -> list[str]:
    problem, solution = trail.get("problem", {}), trail.get("solution", {})
    found = []
    commands = [c.get("command", "") for c in solution.get("shell_commands_executed", [])] + [a.get("approach", "") for a in problem.get("failed_approaches", [])]
    if any("<path>" in c for c in commands):
        found.append("commands reduced to <path> placeholders")
    message = problem.get("error_message", "")
    if len(message) < 20 or message.strip().lower() == problem.get("error_type", "").strip().lower():
        found.append("error message too short")
    return found


def select(items: list[dict], task_by_fp: dict[str, str], include_flawed: bool) -> list[tuple[str, str, list[str]]]:
    """(trail id, task id or '-', reasons) for each factory trail that should go."""
    chosen = []
    for item in items:
        trail = item["trail"]
        if trail.get("agent_info", {}).get("model") != "seed-factory":
            continue
        task = task_by_fp.get(item.get("fingerprint", ""), "-")
        reasons = []
        if task in POLICY_EXCLUDED:
            reasons.append(POLICY_EXCLUDED[task])
        if include_flawed:
            reasons += flaws(trail)
        if reasons:
            chosen.append((item["trail_id"], task, reasons))
    return chosen


def call(base: str, method: str, path: str, token: str = "", body: dict | None = None):
    if not (path.startswith("/v1/feed") or (path.startswith("/v1/trails/") and UUID.match(path.rsplit("/", 1)[-1]))):
        raise RuntimeError("retire talks only to the feed and to DELETE /v1/trails/{id}")
    headers = {"accept": "application/json", "user-agent": UA, "content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(base.rstrip("/") + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, json.loads(response.read() or b"{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="https://myrmo.dev")
    parser.add_argument("--seed-out", default=str(OUT))
    parser.add_argument("--flawed", action="store_true", help="also select trails with placeholder commands or a useless error message")
    parser.add_argument("--yes", action="store_true", help="really remove them (needs MYRMO_ADMIN_TOKEN)")
    args = parser.parse_args()
    if not allowed(args.base):
        raise SystemExit("refusing URL: only localhost/private or exactly https://myrmo.dev is allowed")

    _, feed = call(args.base, "GET", "/v1/feed?limit=50")
    chosen = select(feed.get("items", []), task_ids_by_fingerprint(Path(args.seed_out)), args.flawed)
    for trail_id, task, reasons in chosen:
        print(f"{trail_id}  {task:34}  {'; '.join(reasons)}")
    print(f"\n{len(chosen)} trail(s) selected out of {len(feed.get('items', []))} in the feed.")
    if not args.yes:
        print("Nothing removed. Add --yes (and set MYRMO_ADMIN_TOKEN) to remove them.")
        return 0
    token = os.environ.get("MYRMO_ADMIN_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("set MYRMO_ADMIN_TOKEN to the operator token first")
    for trail_id, task, reasons in chosen:
        try:
            call(args.base, "DELETE", f"/v1/trails/{trail_id}", token, {"reason": "; ".join(reasons)[:200]})
            print(f"removed {trail_id}")
        except urllib.error.HTTPError as exc:
            print(f"could not remove {trail_id}: HTTP {exc.code}")
            if exc.code in (401, 501):
                return 1
        time.sleep(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
