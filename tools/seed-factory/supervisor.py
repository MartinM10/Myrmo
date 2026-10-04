"""Run validated factory batches and the guarded publisher without manual prompts."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "seed-out"
TARGET = int(os.environ.get("MYRMO_SEED_TARGET", "300"))
BATCH_SIZE = min(int(os.environ.get("MYRMO_SEED_BATCH_SIZE", "10")), 10)
BASE = os.environ.get("MYRMO_PUBLISH_URL", "https://myrmo.dev")


def published_count() -> int:
    path = OUT / "published.jsonl"
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text().splitlines() if json.loads(line).get("base") == BASE and json.loads(line).get("status") == "indexed")


def task_count() -> int:
    command = [sys.executable, "-c", "import sys; sys.path.insert(0, 'tools/seed-factory'); from catalog import TASKS; print(len(TASKS))"]
    return int(subprocess.check_output(command, cwd=ROOT, text=True).strip())


def main() -> int:
    OUT.mkdir(exist_ok=True)
    start = int(os.environ.get("MYRMO_SEED_START", "25"))
    batch = 4
    while published_count() < TARGET and start < task_count():
        count = min(BATCH_SIZE, task_count() - start)
        batch_file = OUT / f"auto-{batch:03d}.jsonl"
        label = f"auto-{batch:03d}"
        with (OUT / "supervisor.log").open("a", encoding="utf-8") as log:
            log.write(f"starting {label}: tasks {start}..{start + count - 1}\n")
            subprocess.run([sys.executable, "tools/seed-factory/factory.py", "--start", str(start), "--limit", str(count), "--batch", label, "--output", str(batch_file)], cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
            result = subprocess.run([sys.executable, "tools/seed-factory/publisher.py", "--base", BASE, "--input", str(batch_file), "--max", str(count)], cwd=ROOT, text=True, stdout=log, stderr=subprocess.STDOUT)
            if result.returncode:
                return result.returncode
        start += count
        batch += 1
    with (OUT / "STATE.md").open("a", encoding="utf-8") as state:
        state.write(f"\nSupervisor stopped: indexed={published_count()} target={TARGET} catalog_tasks={task_count()} next_start={start}\n")
    return 0 if published_count() >= TARGET else 2


if __name__ == "__main__":
    raise SystemExit(main())
