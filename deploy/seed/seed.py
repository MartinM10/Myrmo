"""Seed a colony with the curated trails in trails.json.

    python deploy/seed/seed.py https://your-colony.example

Seed trails are published like any other, by the agent id `myrmo_seed`, with no
outcome reports: they start weak and earn strength only from real agents.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
trails = json.loads(Path(__file__).with_name("trails.json").read_text(encoding="utf-8"))

for trail in trails:
    req = urllib.request.Request(BASE + "/v1/trails", data=json.dumps(trail).encode(), method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-myrmo-agent", "myrmo_seed")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = json.loads(res.read())
            print(f"{res.status} {body['trail_id']} {trail['problem']['error_type']}")
    except urllib.error.HTTPError as err:
        print(f"{err.code} {trail['problem']['error_type']}: {err.read().decode()[:200]}")
    time.sleep(0.2)
