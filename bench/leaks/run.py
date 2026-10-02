"""Leak test bank: plants sensitive strings in trails and checks what the colony lets through.

    python bench/leaks/run.py [http://localhost:8080]

Needs a running colony (docker compose up -d) and publishes real trails to it: use a local
colony, never production. Exit status is 1 when something that must be caught escapes, or
when a dangerous command is not flagged. Known gaps are reported but do not fail the run.
"""

from __future__ import annotations

import copy
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import defaultdict
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = json.loads((ROOT / "protocol/examples/trail.distutils.json").read_text(encoding="utf-8"))
CASES = json.loads(Path(__file__).with_name("cases.json").read_text(encoding="utf-8"))
for _case in CASES:
    # Cases shaped like a vendor key are stored in parts (see build_cases.py) and joined here.
    if "plant_parts" in _case:
        _case["plant"] = "".join(_case["plant_parts"])
RANK = {"low": 1, "medium": 2, "high": 3}


def _json(raw):
    try:
        return json.loads(raw or b"null") or {}
    except ValueError:
        return {}  # /healthz answers plain text


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("x-myrmo-agent", "leak_bank_" + uuid.uuid4().hex[:8])
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, _json(res.read())
    except urllib.error.HTTPError as err:
        return err.code, _json(err.read())


def build(case):
    """A valid trail, unique per case, with the planted string in the chosen field."""
    trail = copy.deepcopy(EXAMPLE)
    tag = uuid.uuid4().hex[:6]
    trail["environment"]["runtime"]["version"] = f"3.{int(tag, 16) % 900 + 100}.0"
    trail["problem"]["error_message"] = f"ModuleNotFoundError: No module named 'leak_{tag}'"
    text = case.get("prefix", "") + case["plant"] + case.get("suffix", "")
    where = case["where"]
    if where == "problem.raw_logs":
        trail["problem"]["raw_logs"] += "\n" + text
    elif where == "problem.error_message":
        trail["problem"]["error_message"] += f" ({text})"
    elif where == "problem.summary":
        trail["problem"]["summary"] = (text + " " + trail["problem"]["summary"])[:1000]
    elif where == "solution.steps":
        trail["solution"]["steps"].append(text)
    elif where == "command":
        trail["solution"]["shell_commands_executed"].append({"command": text, "purpose": "Run the step."})
    elif where == "diff":
        trail["solution"]["code_patches"][0]["diff"] += text + "\n"
    return trail


def verdict(case, trail):
    status, body = call("POST", "/v1/trails", trail)
    if status != 202:
        return "rejected", f"HTTP {status} {body.get('error', {}).get('code', '')}", None
    trail_id = body["trail_id"]
    for _ in range(240):
        status, meta = call("GET", f"/v1/trails/{trail_id}")
        if meta.get("status") not in ("queued", None):
            break
        time.sleep(0.5)
    state = meta.get("status")
    if state == "rejected":
        return "rejected", ",".join(meta.get("reasons", [])), meta
    if state == "indexed":
        stored = json.dumps(meta.get("trail", {}))
        return ("leaked" if case["plant"] in stored else "redacted"), "", meta
    return state or "unknown", "", meta


def main():
    if call("GET", "/healthz")[0] != 200:
        sys.exit(f"No colony at {BASE}. Start one with: docker compose up -d")
    rows, failures = [], []
    by_cat = defaultdict(lambda: [0, 0])
    for case in CASES:
        outcome, why, meta = verdict(case, build(case))
        if case["expect"] == "flagged":
            level = (meta or {}).get("risk", {}).get("level", "low")
            # Rejecting the trail is stricter than flagging its command, so it passes too.
            ok = outcome == "rejected" or RANK.get(level, 1) >= RANK[case["min_risk"]]
            result = f"rejected ({why})" if outcome == "rejected" else (f"flagged {level}" if ok else f"NOT FLAGGED ({level})")
        else:
            stopped = outcome in ("rejected", "redacted", "merged")
            ok = stopped if case["expect"] == "caught" else True
            result = ("stopped" if stopped else "ESCAPED") + (f" ({outcome}{': ' + why if why else ''})" if stopped else "")
        by_cat[case["category"]][0] += 1
        if (case["expect"] == "gap" and outcome not in ("rejected", "redacted", "merged")):
            by_cat[case["category"]][1] += 1
        if not ok:
            failures.append(case["id"])
        rows.append((case["category"], case["id"], case["expect"], result))

    width = max(len(r[1]) for r in rows)
    for category, cid, expect, result in rows:
        mark = "  " if expect != "gap" else "~ "
        print(f"{mark}{category:<18} {cid:<{width}}  expect {expect:<8} -> {result}")
    gaps = [r for r in rows if r[2] == "gap" and r[3].startswith("ESCAPED")]
    must = [r for r in rows if r[2] == "caught"]
    caught = [r for r in must if r[3].startswith("stopped")]
    print(f"\nmust be caught: {len(caught)}/{len(must)}   known gaps still open: {len(gaps)}/{sum(1 for r in rows if r[2] == 'gap')}")
    if failures:
        print("FAILED:", ", ".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
