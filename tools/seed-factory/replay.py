"""Replay what a colony serves, the way an agent that follows a trail would.

    python tools/seed-factory/replay.py --base http://localhost:8080 --input seed-out/lot-001.jsonl

For each trail of the lot: fetch it from the colony (so it is the redacted copy an agent would get), start a clean
container of the task's image, run the command that fails and check that it still fails, then run only the commands the
trail lists and check that they succeed. A trail that redaction or the colony broke is found here, before anyone
follows it. Writes <input>.replay.json next to the lot.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "protocol"))
import factory  # noqa: E402
from catalog import TASKS  # noqa: E402

BY_ID = {t.task_id: t for t in TASKS}


def served(base: str, fingerprint: str, message: str) -> dict | None:
    req = urllib.request.Request(f"{base.rstrip('/')}/v1/trails/by-fingerprint/{urllib.parse.quote(fingerprint)}", headers={"user-agent": "myrmo-replay/1.0"})
    try:
        results = json.loads(urllib.request.urlopen(req, timeout=60).read())["results"]
    except Exception:  # noqa: BLE001 (a missing trail is a finding, not a crash)
        return None
    return next((r["trail"] for r in results if r["trail"]["problem"]["error_message"] == message), results[0]["trail"] if results else None)


def replay_one(base: str, row: dict) -> dict:
    task_id = row["_factory"]["task_id"]
    task = BY_ID[task_id]
    trail = served(base, row["fingerprint"], row["problem"]["error_message"])
    if trail is None:
        return {"task": task_id, "ok": False, "why": "the colony does not serve it"}
    commands = [c["command"] for c in trail["solution"]["shell_commands_executed"]]
    if not commands:
        return {"task": task_id, "ok": False, "why": "the served trail has no commands"}
    changed = [c for c, original in zip(commands, [x["command"] for x in row["solution"]["shell_commands_executed"]]) if c != original]
    steps = " && ".join(f"{{ {c}; }}" for c in commands)
    script = f"( {task.failing_command} ) >/dev/null 2>&1; echo __FAILING_EXIT__=$?; {steps}; echo __TRAIL_EXIT__=$?"
    try:
        result = factory.run(task, script)
    except factory.SetupFailed:
        return {"task": task_id, "ok": False, "why": "the task's setup failed"}
    out = result["stdout"]
    failing = next((int(l.split("=")[1]) for l in out.splitlines() if l.startswith("__FAILING_EXIT__=")), None)
    followed = next((int(l.split("=")[1]) for l in out.splitlines() if l.startswith("__TRAIL_EXIT__=")), None)
    ok = failing not in (None, 0) and followed == 0
    why = "" if ok else ("the failing command no longer fails" if failing == 0 else f"the trail's commands exit {followed}: {(result['stderr'] or out)[-300:]!r}")
    return {"task": task_id, "ok": ok, "why": why, "commands_changed_by_redaction": changed}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8080")
    parser.add_argument("--input", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    rows = [json.loads(l) for l in Path(args.input).read_text(encoding="utf-8").splitlines() if l.strip()]
    for image in sorted({BY_ID[r["_factory"]["task_id"]].image for r in rows}):
        factory.subprocess.run(["docker", "pull", "-q", image], capture_output=True, text=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda r: replay_one(args.base, r), rows))
    Path(args.input).with_suffix(".replay.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    bad = [r for r in results if not r["ok"]]
    for r in bad:
        print(f"FAIL {r['task']}: {r['why']}")
    print(f"{len(results) - len(bad)} of {len(results)} trails replay from the colony's copy")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
