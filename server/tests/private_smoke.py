"""End-to-end check of a private colony: a gateway started with MYRMO_REQUIRE_KEY=1.

    python server/tests/private_smoke.py <base_url> <gateway container>

It creates two people's keys with `docker exec <container> myrmo-server keys add`, revokes them at the end, and never
prints a key. Uses only the standard library. Exits non-zero on the first failed check.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = sys.argv[1].rstrip("/")
CONTAINER = sys.argv[2]
ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = json.loads((ROOT / "protocol/examples/trail.distutils.json").read_text(encoding="utf-8"))
REPORT = {"protocol_version": "1.0", "outcome": "worked", "agent_info": {"model": "m", "framework": "f"}}


def call(method: str, path: str, body: dict | None = None, key: str | None = None, headers: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("content-type", "application/json")
    if key is not None:
        req.add_header("authorization", f"Bearer {key}")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


def check(condition: bool, message: str) -> None:
    print(("  ok    " if condition else "  FAIL  ") + message)
    if not condition:
        sys.exit(1)


def keys(*args: str) -> str:
    done = subprocess.run(["docker", "exec", CONTAINER, "myrmo-server", "keys", *args], capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"keys {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout.strip()


# Unique names, so the check can run against a colony that already has people.
ana, luis = f"ana-{uuid.uuid4().hex[:6]}", f"luis-{uuid.uuid4().hex[:6]}"
key_a, key_b = keys("add", ana), keys("add", luis)
try:
    print("access")
    check(call("POST", "/v1/search", {"query": "x failed here"})[0] == 401, "no key: 401")
    check(call("POST", "/v1/search", {"query": "x failed here"}, key="myk_" + "0" * 64)[0] == 401, "an unknown key: 401")
    check(call("GET", "/v1/feed")[0] == 401, "every /v1 route needs a key, reads included")
    check(call("POST", "/v1/search", {"query": "x failed here"}, key=key_a)[0] == 200, "a person's key: 200")
    with urllib.request.urlopen(BASE + "/healthz", timeout=10) as res:
        check(res.status == 200, "/healthz stays open")
    check(ana in keys("list") and key_a not in keys("list"), "keys list names people, never keys")

    print("one person, one identity")
    trail = json.loads(json.dumps(EXAMPLE))
    trail["problem"]["error_message"] += f" ({uuid.uuid4().hex[:8]})"
    status, body = call("POST", "/v1/trails", trail, key=key_a, headers={"x-myrmo-agent": "someone-else-entirely"})
    check(status == 202, f"ana publishes ({status})")
    tid = body["trail_id"]
    for _ in range(90):
        state = call("GET", f"/v1/trails/{tid}", key=key_a)[1].get("status")
        if state != "queued":
            break
        time.sleep(1)
    check(state == "indexed", f"the trail is indexed ({state})")
    hits = call("POST", "/v1/search", {"query": trail["problem"]["error_message"]}, key=key_b)[1]["results"]
    check(any(h["trail_id"] == tid for h in hits), "luis finds ana's trail")
    status, body = call("POST", f"/v1/trails/{tid}/outcomes", REPORT, key=key_b)
    check(status == 202 and body["counted"] is True, "luis's report counts, though both share an address")
    check(call("POST", f"/v1/trails/{tid}/outcomes", REPORT, key=key_b)[1]["counted"] is False, "once per person and day")
    status, body = call("POST", f"/v1/trails/{tid}/outcomes", REPORT, key=key_a, headers={"x-myrmo-agent": "fresh-agent-id-123"})
    check(body["counted"] is False, "ana cannot reinforce her own trail, whatever agent id she sends")

    print("revoking")
    keys("revoke", luis)
    check(call("POST", "/v1/search", {"query": "x failed here"}, key=key_b)[0] == 401, "a revoked key stops working at once")
finally:
    for person in (ana, luis):
        subprocess.run(["docker", "exec", CONTAINER, "myrmo-server", "keys", "revoke", person], capture_output=True)
print("private colony: all checks passed")
