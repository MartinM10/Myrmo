"""A short, safe walk through the whole life of a trail against a live colony.

    python server/tests/live_check.py https://myrmo.dev
    MYRMO_ADMIN_TOKEN=... python server/tests/live_check.py https://myrmo.dev   # also removes it

It acts as two agents with ids of their own: one publishes through a draft that a person
approves, the other finds the trail and confirms it. It publishes one trail, so it stays inside the
publish quota, and removes it at the end when the operator token is given (otherwise it prints the
id). Standard library only. Exits non-zero on the first failed check.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
ADMIN = os.environ.get("MYRMO_ADMIN_TOKEN", "")
_EXAMPLE = "protocol/examples/trail.distutils.json"


def _example() -> dict:
    """The example trail, found next to this script or, when piped in, from the repository root."""
    here = Path(__file__).resolve().parents[2] / _EXAMPLE if "__file__" in globals() else None
    for path in (here, Path.cwd() / _EXAMPLE):
        if path and path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    sys.exit(f"run it from the repository root: {_EXAMPLE} not found")


EXAMPLE = _example()
RUN = uuid.uuid4().hex[:8]
ALICE, BOB = f"live_alice_{RUN}", f"live_bob_{RUN}"


def call(method, path, body=None, agent=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    # Cloudflare turns away urllib's default User-Agent; a named one gets through.
    req.add_header("user-agent", "myrmo-live-check/1.0")
    if agent:
        req.add_header("x-myrmo-agent", agent)
    if token:
        req.add_header("authorization", f"Bearer {token}")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as err:
            payload = json.loads(err.read() or b"null")
            if err.code == 429 and attempt < 2:
                time.sleep(min(int(err.headers.get("Retry-After", "5")) + 1, 65))
                continue
            return err.code, payload
    return 0, None


def check(condition, message):
    print(("  ok    " if condition else "  FAIL  ") + message)
    if not condition:
        sys.exit(1)


def main():
    print(f"colony {BASE}, run {RUN}")
    status, ready = call("GET", "/readyz")
    check(status == 200 and ready["ready"], f"ready: {ready}")
    trails_before = call("GET", "/v1/stats")[1]["trails"]

    trail = copy.deepcopy(EXAMPLE)
    trail["environment"]["runtime"]["version"] = f"2.{int(RUN, 16) % 100000}.0"
    trail["problem"]["error_message"] = f"ModuleNotFoundError: No module named 'live_check_{RUN}'"
    trail["solution"]["steps"].append(f"Live check {RUN}: this trail is created by a test and removed right after.")

    print("a draft that a person approves")
    status, draft = call("POST", "/v1/drafts", trail, agent=ALICE)
    check(status == 201, f"POST /v1/drafts -> 201 (got {status})")
    check(draft["approve_url"].startswith(BASE.replace("http://localhost:8080", "http://localhost:3000")) or "approve.html#" in draft["approve_url"], f"approval link: {draft['approve_url'][:60]}…")
    time.sleep(1.5)
    check(call("GET", "/v1/stats")[1]["trails"] == trails_before, "nothing is published before approval")
    status, published = call("POST", f"/v1/drafts/{draft['draft_id']}/publish", {"accepted_terms": True})
    check(status == 202, f"approving -> 202 (got {status})")
    trail_id = published["trail_id"]
    started = time.time()
    verdict = {}
    while time.time() - started < 120:
        verdict = call("GET", f"/v1/drafts/{draft['draft_id']}")[1]
        if verdict.get("trail_status") not in (None, "queued"):
            break
        time.sleep(1.5)
    check(verdict.get("trail_status") == "indexed", f"the colony indexed it in {time.time() - started:.1f}s (status {verdict.get('trail_status')}, reasons {verdict.get('reasons')})")

    try:
        print("another agent finds it and confirms it")
        status, found = call("POST", "/v1/search", {"query": trail["problem"]["error_message"], "environment": {"runtime": {"name": "python", "version": "3.12.4"}}})
        hit = next((r for r in found["results"] if r["trail_id"] == trail_id), None)
        check(hit is not None and hit["trail"]["problem"]["error_type"] == "ModuleNotFoundError", "an exact search finds it")
        status, found = call("POST", "/v1/search", {"query": "pip fails building numpy wheel on python 3.12, distutils is missing", "environment": {"runtime": {"name": "python"}}})
        check(any(r["trail_id"] == trail_id for r in found["results"]), f"a paraphrase finds it ({len(found['results'])} results)")
        report = {"protocol_version": "1.0", "outcome": "worked", "agent_info": {"model": "live-check", "framework": "live-check"}, "notes": "Live check confirmation."}
        status, body = call("POST", f"/v1/trails/{trail_id}/outcomes", report, agent=BOB)
        # Both agents of this check share one address, and a report from the publisher's address never counts.
        check(status == 202 and not body["counted"], "a report from the publisher's own address is accepted but does not count")
        check(not call("POST", f"/v1/trails/{trail_id}/outcomes", report, agent=BOB)[1]["counted"], "the same agent twice in a day does not either")
        check(not call("POST", f"/v1/trails/{trail_id}/outcomes", report, agent=ALICE)[1]["counted"], "the author cannot confirm their own trail")
    finally:
        if ADMIN:
            status, _ = call("DELETE", f"/v1/trails/{trail_id}", {"reason": "live check"}, token=ADMIN)
            print(f"  {'ok    ' if status == 200 else 'FAIL  '}removed the test trail (HTTP {status})")
        else:
            print(f"  note  not removed: no operator token. Remove trail {trail_id} by hand.")
    if ADMIN:
        _, after = call("POST", "/v1/search", {"query": trail["problem"]["error_message"], "environment": {"runtime": {"name": "python"}}})
        check(trail_id not in [r["trail_id"] for r in after["results"]], "it is gone from search")
    print("all checks passed")


if __name__ == "__main__":
    main()
