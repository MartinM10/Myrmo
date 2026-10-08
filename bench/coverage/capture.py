"""Run probes in Docker and keep the error line each one prints.

    python bench/coverage/capture.py                 # every probe that has no capture yet
    python bench/coverage/capture.py --all           # again, all of them
    python bench/coverage/capture.py py-uv-no-venv   # these only

The result of each probe is kept in captures/<id>.json: the picked line, the tail of the output, the command and the
digest of the image it ran in. A probe whose command does not fail with a line that matches `pick` is reported and not
kept: a breakage that does not reproduce is not a breakage.
"""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
CAPTURES = HERE / "captures"
SETUP_FAILED = 99
TIMEOUT = 1500
ECOSYSTEMS = ("python", "node", "jvm", "go", "rust", "dotnet", "docker", "tls", "platform")


def all_probes():
    probes = []
    for name in ECOSYSTEMS:
        try:
            probes.extend(importlib.import_module(f"probes.{name}").PROBES)
        except ModuleNotFoundError as err:
            if err.name != f"probes.{name}":
                raise
    ids = [p.id for p in probes]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit(f"duplicate probe ids: {sorted(dup)}")
    return probes


def image_digest(image: str) -> str | None:
    out = subprocess.run(["docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", image], capture_output=True, text=True)
    digest = out.stdout.strip()
    return digest if out.returncode == 0 and "@sha256:" in digest else None


def run_probe(probe) -> dict:
    script = f"{{\n{probe.setup}\n}} >/dev/null 2>&1 || {{ echo 'capture: setup failed' >&2; exit {SETUP_FAILED}; }}\n{probe.command}"
    started = subprocess.run(
        ["docker", "run", "--rm", "--init", "--cpus=2", "--memory=2g", probe.image, "sh", "-c", script],
        capture_output=True, text=True, timeout=TIMEOUT,
    )
    text = (started.stdout + "\n" + started.stderr).strip()
    if started.returncode == SETUP_FAILED and "capture: setup failed" in started.stderr:
        return {"id": probe.id, "ok": False, "why": "the setup failed"}
    line = ""
    for candidate in text.splitlines():
        match = re.search(probe.pick, candidate)
        if match:  # a capture group, when the pattern has one, is the part of the line worth keeping
            line = (match.group(1) if match.groups() else candidate).strip()
            break
    if not line:
        return {"id": probe.id, "ok": False, "why": f"no line matches {probe.pick!r} (exit {started.returncode}); output ends: {text[-300:]!r}"}
    return {"id": probe.id, "ok": True, "error_line": line[:400], "exit_code": started.returncode, "output_tail": text[-1500:],
            "image": probe.image, "image_digest": image_digest(probe.image), "command": probe.command}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("ids", nargs="*")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    CAPTURES.mkdir(exist_ok=True)
    probes = [p for p in all_probes() if (not args.ids or p.id in args.ids) and (args.all or args.ids or not (CAPTURES / f"{p.id}.json").exists())]
    for p in probes:
        if p.local_image:
            subprocess.run(["docker", "build", "-q", "-t", p.image, str(HERE.parents[1] / "tools/seed-factory/images" / p.image.split(":")[0].split("/")[-1])], capture_output=True)
    for image in sorted({p.image for p in probes if not p.local_image}):
        subprocess.run(["docker", "pull", "-q", image], capture_output=True)
    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_probe, p): p for p in probes}
        for future in as_completed(futures):
            probe = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # timeout or Docker failing
                result = {"id": probe.id, "ok": False, "why": f"{type(exc).__name__}: {exc}"}
            if result["ok"]:
                (CAPTURES / f"{probe.id}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                print(f"ok    {probe.id}: {result['error_line'][:110]}")
            else:
                failures += 1
                print(f"FAIL  {probe.id}: {result['why']}")
    print(f"\n{len(probes) - failures} captured, {failures} did not reproduce")
    return 0


if __name__ == "__main__":
    sys.exit(main())
