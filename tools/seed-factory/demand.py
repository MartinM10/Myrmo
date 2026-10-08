"""Let what agents ask for decide what the factory makes next.

    python tools/seed-factory/demand.py wanted [--base https://myrmo.dev]
    MYRMO_ADMIN_TOKEN=... python tools/seed-factory/demand.py check [--base https://myrmo.dev]

`wanted` reads the public list of errors that at least three distinct agents asked for and nobody has answered
(GET /v1/demand) and writes it to candidates/_demand.json. The colony does not keep what an agent typed, only the
runtime and the class of the error, so these are hints for a person (or a model) to turn into probes, not error lines.

`check` asks the operator endpoint how many agents searched for the fingerprint of each candidate (GET /v1/demand?
fingerprints=...), and raises the score of the ones somebody is looking for. It needs the operator token in the
environment; the token goes only into the Authorization header of that request and is never written to a file.
Both only read.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "protocol"))
from fingerprint_v2 import fingerprint  # noqa: E402

UA = "myrmo-seed-demand/1.0"


def get(base: str, path: str, token: str | None = None) -> dict:
    req = urllib.request.Request(base.rstrip("/") + path, headers={"accept": "application/json", "user-agent": UA})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def wanted(base: str) -> int:
    data = get(base, "/v1/demand?days=7")
    hints = [{"runtime": e.get("runtime", ""), "error_type": e.get("error_type", ""), "agents": e.get("agents"), "searches": e.get("searches"),
              "status": "hint", "note": "a class of error somebody asked for; turn it into a probe before it becomes a task"} for e in data.get("unanswered", [])]
    (HERE / "candidates").mkdir(exist_ok=True)
    (HERE / "candidates" / "_demand.json").write_text(json.dumps(hints, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(hints)} wanted error classes written to candidates/_demand.json")
    return 0


def check(base: str) -> int:
    token = os.environ.get("MYRMO_ADMIN_TOKEN")
    if not token:
        print("Set MYRMO_ADMIN_TOKEN in your environment to ask which candidates are being searched for.", file=sys.stderr)
        return 2
    items = []
    for path in sorted((HERE / "candidates").glob("*.json")):
        if path.name.startswith("_"):
            continue
        for entry in json.loads(path.read_text(encoding="utf-8")):
            items.append((path, entry, fingerprint(entry["error_line"])))
    asked: dict[str, dict] = {}
    for i in range(0, len(items), 50):
        chunk = [fp for _, _, fp in items[i : i + 50]]
        data = get(base, "/v1/demand?" + urllib.parse.urlencode({"days": 30, "fingerprints": ",".join(chunk)}), token)
        asked.update({row["fingerprint"]: row for row in data.get("fingerprints", [])})
    touched = {}
    for path, entry, fp in items:
        row = asked.get(fp)
        entry["demand"] = {"agents": row["agents"], "searches": row["searches"]} if row else {"agents": 0, "searches": 0}
        touched.setdefault(path, []).append(entry)
    for path, entries in touched.items():
        full = json.loads(path.read_text(encoding="utf-8"))
        by_id = {e["id"]: e for e in entries}
        for entry in full:
            entry["demand"] = by_id[entry["id"]]["demand"]
        full.sort(key=lambda e: (-e["demand"]["agents"], -e["score"]["total"], e["id"]))
        path.write_text(json.dumps(full, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(items)} candidates asked about; {len(asked)} have been searched for")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["wanted", "check"])
    parser.add_argument("--base", default="https://myrmo.dev")
    args = parser.parse_args()
    return wanted(args.base) if args.mode == "wanted" else check(args.base)


if __name__ == "__main__":
    sys.exit(main())
