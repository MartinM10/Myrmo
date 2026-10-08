"""The list of breakages worth turning into trails, by ecosystem, with where each one stands.

    python tools/seed-factory/candidates.py          # rewrites candidates/<ecosystem>.json

Each entry comes from a probe of bench/coverage that fell on the `candidate` half (the reserved half is never listed here).
Its status is `reproduced` when the factory made a valid trail from it, `todo` when nobody has written the task yet, and
`rejected` with the reason when it cannot or should not become a trail. The score follows the criteria of the
publication policy and says why an entry is where it is:

  recent       the breakage comes from a release of the last 18 months (what a model trained earlier does not know)
  environment  it depends on a combination (libc, base image, certificate authority, tool and runtime versions)
  transferable the fix does not depend on the user's own code (always true here: probes are chosen that way)
  reproducible it fails in a pinned image (always true here: a probe that does not reproduce is dropped)
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from catalog import TASKS  # noqa: E402

RECENT = {
    "py-numpy2-float_", "py-numpy2-nan", "py-httpx028-proxies", "py-torch26-weights-only", "py-poetry2-export", "py-setuptools75-test-command",
    "py-uv-no-venv", "py-pydantic2-basesettings", "node-pnpm10-ignored-build-sqlite3", "node-tailwind4-postcss", "node-jest30-testpathpattern",
    "node-corepack-keyid", "node-esm-json-import-attribute", "jvm-lombok-jdk23", "jvm-gradle73-jdk21", "rust-edition2024-old-cargo",
    "rust-msrv-dependency", "rust-lockfile-v4-old-cargo", "dotnet-sdk8-targets-net9", "go-toolchain-local-too-new", "docker-compose-env-file-missing",
}
ENVIRONMENT_PREFIXES = ("tls-", "platform-", "k8s-", "docker-", "go-cgo", "jvm-java17", "jvm-classfile", "py-urllib3")

#: Breakages considered and set aside before they became probes, with the reason.
SET_ASIDE = {
    "terraform-provider-constraints": "its documentation is under a licence the project cannot build on (BUSL), and OpenTofu's is MPL-2.0",
    "github-actions-deprecated-action": "needs GitHub's runners to fail: it cannot be reproduced in a container",
    "database-client-auth": "the usual sources (PostgreSQL, MySQL, Redis) are under licences outside the policy; no permissive source describes them",
    "arm64-exec-format": "needs arm64 emulation, which this machine does not have",
    "py-torch-cpu-wheel-cuda": "the fix downloads several gigabytes of CUDA wheels, more than a factory container can hold",
    "py-psycopg2-alpine-pg_config": "psycopg2 is LGPL, a licence outside the policy",
    "py-pillow-antialias": "Pillow's licence (HPND) is outside the policy",
    "py-python313-cgi": "Python's own documentation is PSF-licensed; replaced by PEP 594 (CC0) as the source, kept only as a coverage line",
}


def score(probe_id: str) -> dict:
    parts = {"recent": probe_id in RECENT, "environment": probe_id.startswith(ENVIRONMENT_PREFIXES), "transferable": True, "reproducible": True}
    return {**parts, "total": sum(parts.values())}


def main() -> int:
    made = {t.task_id for t in TASKS if t.probe}
    lines = [json.loads(l) for l in (ROOT / "bench/coverage/lines.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    rejected_probes = json.loads((ROOT / "bench/coverage/rejected-probes.json").read_text(encoding="utf-8"))
    valid = set()
    for lot in (ROOT / "seed-out").glob("lot-*.jsonl"):
        if lot.name.endswith(".replay.json"):
            continue
        valid |= {json.loads(l)["_factory"]["task_id"] for l in lot.read_text(encoding="utf-8").splitlines() if l.strip()}
    by_eco = defaultdict(list)
    for line in lines:
        if line["split"] != "candidate":
            continue
        pid = line["id"]
        if pid in SET_ASIDE:
            status, reason = "rejected", SET_ASIDE[pid]
        else:
            status, reason = ("reproduced", "") if pid in valid else ("todo", "") if pid not in made else ("todo", "task written, not yet valid")
        by_eco[line["ecosystem"]].append({"id": pid, "error_line": line["error_line"], "versions": line["versions"], "source": line["source"],
                                          "score": score(pid), "status": status, "reason": reason})
    (HERE / "candidates").mkdir(exist_ok=True)
    for eco, items in by_eco.items():
        items.sort(key=lambda x: (-x["score"]["total"], x["id"]))
        (HERE / "candidates" / f"{eco}.json").write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    rejected = [{"id": k, "status": "rejected", "reason": v} for k, v in {**SET_ASIDE, **rejected_probes}.items()]
    (HERE / "candidates" / "_rejected.json").write_text(json.dumps(rejected, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print({eco: {s: sum(1 for i in items if i["status"] == s) for s in ("reproduced", "todo", "rejected")} for eco, items in sorted(by_eco.items())}, f"rejected: {len(rejected)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
