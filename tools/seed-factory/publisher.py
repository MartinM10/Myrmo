"""Guarded publisher. Production access is intentionally limited to publish and verdict GET."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provenance  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("MYRMO_SEED_OUT", ROOT / "seed-out"))
MAX_PER_HOUR = 25
WINDOW_SECONDS = 3600
AGENT = "seed-factory"
UA = "myrmo-seed-factory/1.0"


def allowed(base: str) -> bool:
    parsed = urlparse(base.rstrip("/"))
    if parsed.scheme == "https" and parsed.hostname == "myrmo.dev":
        return True
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    if parsed.hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_private or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


def request(base: str, method: str, path: str, body=None):
    if path != "/v1/trails" and not path.startswith("/v1/trails/"):
        raise RuntimeError("publisher permits only trail publish and verdict endpoints")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method, headers={"content-type": "application/json", "accept": "application/json", "x-myrmo-agent": AGENT, "user-agent": UA})
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.status, json.loads(response.read() or b"{}")


def payload(trail: dict) -> dict:
    """What is sent: protocol v1 only. The factory's bookkeeping (keys that start with an underscore, the fingerprint) stays here."""
    return {k: v for k, v in trail.items() if not k.startswith("_") and k != "fingerprint"}


def provenance_problems(trail: dict) -> list[str]:
    """No provenance, no publication: the record must pass the licence policy and describe exactly what would be sent."""
    found = provenance.check(trail.get("_provenance"))
    if not found and provenance.content_hash(payload(trail)) != trail["_provenance"]["content_sha256"]:
        found.append("the trail changed after its provenance was recorded")
    return found


def exists_on_server(base: str, fingerprint: str) -> bool:
    """The colony is the source of truth: a trail already there (even from another run or machine) is skipped."""
    try:
        status, _ = request(base, "GET", f"/v1/trails/by-fingerprint/{fingerprint}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    return status == 200


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("MYRMO_PUBLISH_URL", "http://localhost:8080"))
    parser.add_argument("--input", default=str(OUT / "pilot.jsonl"))
    parser.add_argument("--max", type=int, default=20)
    args = parser.parse_args()
    if not allowed(args.base):
        raise SystemExit("refusing URL: only localhost/private or exactly https://myrmo.dev is allowed")
    if args.max > MAX_PER_HOUR:
        raise SystemExit("refusing batch over 25 publications per hour")
    records = OUT / "published.jsonl"
    history = [json.loads(line) for line in records.read_text().splitlines()] if records.exists() else []
    published = {(item.get("base"), item.get("fingerprint")) for item in history}
    trails = [json.loads(line) for line in Path(args.input).read_text().splitlines()][:args.max]
    errors_5xx = rejects = 0
    with records.open("a", encoding="utf-8") as output:
        for trail in trails:
            if (args.base.rstrip("/"), trail.get("fingerprint")) in published:
                continue
            problems = provenance_problems(trail)
            if problems:
                print(f"skipping {trail.get('fingerprint')}: {'; '.join(problems)}")
                continue
            if exists_on_server(args.base, trail["fingerprint"]):
                print(f"skipping {trail['fingerprint']}: already in the colony")
                continue
            while True:
                recent = sorted(item.get("submitted_at", 0) for item in history if item.get("base") == args.base.rstrip("/") and time.time() - item.get("submitted_at", 0) < WINDOW_SECONDS)
                if len(recent) < MAX_PER_HOUR:
                    break
                time.sleep(max(1, recent[0] + WINDOW_SECONDS - time.time()))
            submitted_at = time.time()
            while True:
                try:
                    status, created = request(args.base, "POST", "/v1/trails", payload(trail))
                    errors_5xx = 0
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code == 429:
                        time.sleep(3600)
                        continue
                    if exc.code >= 500:
                        errors_5xx += 1
                        if errors_5xx >= 3:
                            raise SystemExit("stopping after three consecutive 5xx responses")
                        time.sleep(2 ** errors_5xx * 5)
                        continue
                    # The colony refused this trail as invalid: note it, count it and go on with the next.
                    created = None
                    refusal = {"base": args.base.rstrip("/"), "fingerprint": trail["fingerprint"], "status": "invalid", "reasons": [f"HTTP {exc.code}"], "submitted_at": submitted_at}
                    output.write(json.dumps(refusal) + "\n")
                    output.flush()
                    history.append(refusal)
                    rejects += 1
                    if rejects >= 5:
                        raise SystemExit("stopping after five consecutive rejections")
                    break
            if created is None:
                continue
            trail_id = created["trail_id"]
            while True:
                time.sleep(2)
                _, verdict = request(args.base, "GET", f"/v1/trails/{trail_id}")
                if verdict.get("status") != "queued":
                    break
            if verdict.get("status") == "rejected":
                rejects += 1
                if rejects >= 5:
                    raise SystemExit("stopping after five consecutive rejections")
            else:
                rejects = 0
            record = {"base": args.base.rstrip("/"), "fingerprint": trail["fingerprint"], "trail_id": trail_id, "status": verdict.get("status"), "reasons": verdict.get("reasons", []), "submitted_at": submitted_at, "verdict_at": time.time(), "verdict_seconds": round(time.time() - submitted_at, 3)}
            output.seek(0, 2)
            output.write(json.dumps(record) + "\n")
            output.flush()
            published.add((args.base.rstrip("/"), trail["fingerprint"]))
            history.append(record)
            # The ledger ties each trail in the colony to where it came from. It is append-only and never leaves this machine.
            with (OUT / "provenance.jsonl").open("a", encoding="utf-8") as ledger:
                ledger.write(json.dumps({"base": record["base"], "fingerprint": record["fingerprint"], "trail_id": trail_id, "status": record["status"], "provenance": trail["_provenance"]}, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
