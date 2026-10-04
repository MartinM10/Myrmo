from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "protocol"))
from fingerprint_v1 import fingerprint
from catalog import TASKS, Task

SCHEMA = json.loads((ROOT / "protocol/trail.v1.schema.json").read_text())
OUT = ROOT / "seed-out"
TIMEOUT = 300
MAX_WORKERS = max(1, min((os.cpu_count() or 1) // 2, 32))
BATCH = "pilot-001"
PRIVATE = re.compile(r"/(?:home|root|tmp|workspace|workspaces)/[^\s'\"]+|\b(?:[a-z][a-z0-9_-]{2,31})@[a-z0-9.-]+\b", re.I)


def run(task: Task, command: str) -> dict:
    full = f"{task.setup}\n{command}" if task.setup else command
    started = time.monotonic()
    label = f"seed-factory.run={uuid.uuid4().hex}"
    docker_command = ["docker", "run", "--rm", "--init", "--label", label, "--cpus=1", "--memory=512m", task.image, "sh", "-c", full]
    try:
        p = subprocess.run(docker_command, capture_output=True, text=True, timeout=TIMEOUT)
        return {"command": command, "exit_code": p.returncode, "stdout": p.stdout[-8000:], "stderr": p.stderr[-8000:], "seconds": round(time.monotonic() - started, 3)}
    except subprocess.TimeoutExpired as exc:
        containers = subprocess.run(["docker", "ps", "-q", "--filter", f"label={label}"], capture_output=True, text=True).stdout.split()
        if containers:
            subprocess.run(["docker", "rm", "-f", *containers], capture_output=True, text=True)
        return {"command": command, "exit_code": 124, "stdout": (exc.stdout or "")[-8000:], "stderr": "timeout after 300 seconds", "seconds": TIMEOUT}


def clean(value):
    if isinstance(value, str):
        return PRIVATE.sub("<path>", value).replace(str(ROOT), "<project>")
    if isinstance(value, list):
        return [clean(x) for x in value]
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    return value


def trail(task: Task) -> dict:
    failed = [run(task, task.failing_command)] + [run(task, x) for x in task.failed_approaches]
    fixed = run(task, f"{task.fix_command}; {task.verification_command}")
    logs = "\n\n".join((x["stderr"] or x["stdout"] or "(no output)") for x in failed)
    error_line = next((line.strip() for line in logs.splitlines() if task.error_type.lower() in line.lower()), task.error_type)
    candidate = {
        "protocol_version": "1.0",
        "agent_info": {"model": "seed-factory", "framework": "myrmo-seed"},
        "environment": {"os": "linux", "os_version": "container", "arch": "x86_64", "container": "docker", "runtime": task.runtime, "packages": [{"name": task.image, "ecosystem": "other"}]},
        "problem": {"error_type": task.error_type, "error_message": error_line[:1000], "summary": task.summary, "task_context": task.context, "raw_logs": logs[:16000], "category": task.category, "failed_approaches": [{"approach": x["command"], "why_it_failed": (x["stderr"] or x["stdout"] or "command failed")[:500]} for x in failed[1:] if x["exit_code"] != 0]},
        "solution": {"root_cause": task.root_cause, "steps": list(task.steps), "shell_commands_executed": [{"command": task.fix_command, "purpose": "Apply the reproduced fix.", "shell": "sh", "exit_code": 0 if fixed["exit_code"] == 0 else fixed["exit_code"]}, {"command": task.verification_command, "purpose": "Verify the fix with real command output.", "shell": "sh", "exit_code": 0 if fixed["exit_code"] == 0 else fixed["exit_code"]}], "code_patches": [], "verification_method": {"type": "command_exit_zero", "description": "The corrected command and verification command completed successfully in the same fixed image.", "command": task.verification_command, "evidence": (fixed["stdout"] or fixed["stderr"])[-2000:]}},
        "effort": {"failed_attempts": sum(x["exit_code"] != 0 for x in failed), "wall_time_seconds": round(sum(x["seconds"] for x in failed) + fixed["seconds"], 3)},
        "tags": ["seed-factory", BATCH, *task.tags],
        "_factory": {"task_id": task.task_id, "failed": failed, "fixed": fixed},
    }
    return clean(candidate)


def validate(candidate: dict) -> None:
    public = {k: v for k, v in candidate.items() if not k.startswith("_")}
    errors = sorted(Draft7Validator(SCHEMA).iter_errors(public), key=lambda e: list(e.path))
    if errors:
        raise ValueError(f"{candidate['_factory']['task_id']}: {errors[0].message}")
    if candidate["effort"]["failed_attempts"] < 1:
        raise ValueError("a trail must contain a real failed attempt")
    if candidate["_factory"]["fixed"]["exit_code"] != 0:
        raise ValueError("the fix and verification did not exit successfully")
    if any(attempt["exit_code"] == 0 for attempt in candidate["_factory"]["failed"]):
        raise ValueError("a failed approach exited successfully")
    candidate["fingerprint"] = fingerprint(candidate["environment"]["runtime"]["name"], candidate["problem"]["error_type"], candidate["problem"]["error_message"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--batch", default="pilot-001")
    parser.add_argument("--output", default=str(OUT / "pilot.jsonl"))
    args = parser.parse_args()
    global BATCH
    BATCH = args.batch
    OUT.mkdir(exist_ok=True)
    results = []
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, args.limit)) as pool:
        futures = [pool.submit(trail, task) for task in TASKS[args.start : args.start + args.limit]]
        for future in as_completed(futures):
            candidate = future.result()
            try:
                validate(candidate)
                candidate["_factory"]["valid"] = True
            except Exception as exc:
                candidate["_factory"]["valid"] = False
                candidate["_factory"]["validation_error"] = str(exc)
            results.append(candidate)
    results.sort(key=lambda x: x["_factory"]["task_id"])
    (OUT / "pilot-all.jsonl").write_text("\n".join(json.dumps(x, sort_keys=True) for x in results) + "\n", encoding="utf-8")
    seen = set()
    unique = []
    for item in results:
        if item.get("_factory", {}).get("valid") and item["fingerprint"] not in seen:
            seen.add(item["fingerprint"])
            unique.append(item)
    Path(args.output).write_text("\n".join(json.dumps(x, sort_keys=True) for x in unique) + "\n", encoding="utf-8")
    (OUT / "STATE.md").write_text(f"# Seed factory state\n\nPilot tasks: {len(results)}\nValid unique trails: {len(unique)}\nWorkers: {min(MAX_WORKERS, args.limit)}\n\nThe production publisher has not been run.\n", encoding="utf-8")
    print(json.dumps({"tasks": len(results), "valid_unique": len(unique), "invalid": [{"task_id": x["_factory"]["task_id"], "reason": x["_factory"].get("validation_error")} for x in results if not x["_factory"].get("valid")], "workers": min(MAX_WORKERS, args.limit), "output": args.output}, indent=2))
    return 0 if len(unique) == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
