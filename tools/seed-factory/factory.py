from __future__ import annotations

import argparse
import getpass
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
from catalog import MESSAGE_OVERRIDES, TASKS, Task, publishable
import provenance

SCHEMA = json.loads((ROOT / "protocol/trail.v1.schema.json").read_text())
OUT = Path(os.environ.get("MYRMO_SEED_OUT", ROOT / "seed-out"))
TIMEOUT = 300
MAX_WORKERS = max(1, min((os.cpu_count() or 1) // 2, 32))
BATCH = "pilot-001"
FACTORY_VERSION: dict | None = None  # the commit this run was made from, read once
# The tasks run in disposable containers, so paths like /tmp/app are not private and the commands of a
# trail must stay runnable. Only what belongs to this host is replaced (the checkout, the home directory
# and the account name); the colony redacts the rest again on arrival.
def _both_slashes(path: Path) -> set[str]:
    return {str(path), str(path).replace("\\", "/")}


# (text, replacement), longest first: the checkout usually lives inside the home directory.
HOST_PRIVATE = sorted(
    [(p, "<project>") for p in _both_slashes(ROOT) if len(p) > 3] + [(p, "<home>") for p in _both_slashes(Path.home()) if len(p) > 3],
    key=lambda pair: len(pair[0]),
    reverse=True,
)
HOST_USER = getpass.getuser() if len(getpass.getuser()) >= 4 else ""
MIN_ERROR_MESSAGE = 20
# What Docker prints while it fetches an image. It is not output of the task and must not become its error.
DOCKER_NOISE = re.compile(
    r"^(Unable to find image|[\w./-]+: Pulling from|[0-9a-f]{12}: (Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists)|Digest: sha256:|Status: (Downloaded newer image|Image is up to date))"
)


def strip_noise(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not DOCKER_NOISE.match(line.strip()))


SETUP_FAILED = 99
VERIFY_MARK = "__seed_factory_verification__"


class SetupFailed(RuntimeError):
    """The task's own preparation failed (no network, a package not found): nothing it printed means anything."""


def run(task: Task, command: str) -> dict:
    # The setup is silenced so that package-manager output never ends up as the "error" of a trail, and a
    # setup that fails must not be mistaken for the failure the task is meant to show.
    setup = f"{{\n{task.setup}\n}} >/dev/null 2>&1 || {{ echo 'seed-factory: setup failed' >&2; exit {SETUP_FAILED}; }}\n" if task.setup else ""
    full = f"{setup}{command}"
    started = time.monotonic()
    label = f"seed-factory.run={uuid.uuid4().hex}"
    docker_command = ["docker", "run", "--rm", "--init", "--label", label, "--cpus=1", "--memory=512m", task.image, "sh", "-c", full]
    try:
        p = subprocess.run(docker_command, capture_output=True, text=True, timeout=TIMEOUT)
        if p.returncode == SETUP_FAILED and "seed-factory: setup failed" in p.stderr:
            raise SetupFailed(f"{task.task_id}: the setup failed")
        return {"command": command, "exit_code": p.returncode, "stdout": strip_noise(p.stdout)[-8000:], "stderr": strip_noise(p.stderr)[-8000:], "seconds": round(time.monotonic() - started, 3)}
    except subprocess.TimeoutExpired as exc:
        containers = subprocess.run(["docker", "ps", "-q", "--filter", f"label={label}"], capture_output=True, text=True).stdout.split()
        if containers:
            subprocess.run(["docker", "rm", "-f", *containers], capture_output=True, text=True)
        return {"command": command, "exit_code": 124, "stdout": (exc.stdout or "")[-8000:], "stderr": "timeout after 300 seconds", "seconds": TIMEOUT}


def clean(value):
    if isinstance(value, str):
        for private, label in HOST_PRIVATE:
            value = value.replace(private, label)
        if HOST_USER:
            # Only where the name is part of a path or an address, never the bare word (a user called "ubuntu").
            value = re.sub(rf"(?<=[/\\]){re.escape(HOST_USER)}\b|\b{re.escape(HOST_USER)}(?=@)", "<user>", value)
        return value
    if isinstance(value, list):
        return [clean(x) for x in value]
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    return value


def error_line(logs: str, error_type: str, preferred: str = "") -> str:
    """The most informative line of the captured output: the preferred one if it was printed, else the
    one that names the error, else the first line."""
    lines = [line.strip() for line in logs.splitlines() if line.strip()]
    hit = next((line for line in lines if preferred and preferred in line), "")
    if hit:
        return hit[:1000]
    named = next((line for line in lines if error_type.lower() in line.lower()), "")
    return (named or (lines[0] if lines else ""))[:1000]


def verification_evidence(fixed: dict) -> str:
    """What the verification command printed, not what the fix did on the way."""
    out = fixed["stdout"]
    text = out.split(VERIFY_MARK, 1)[1] if VERIFY_MARK in out else (out or fixed["stderr"])
    return (text.strip() or "exit code 0, no output")[-2000:]


def quality_problems(candidate: dict) -> list[str]:
    """Reasons a trail would not help another agent; any of them keeps it out of the lot."""
    problem, solution = candidate["problem"], candidate["solution"]
    found = []
    message = problem.get("error_message", "")
    if len(message) < MIN_ERROR_MESSAGE or message.strip().lower() == problem["error_type"].strip().lower():
        found.append("the error message is too short to find or recognise")
    if len(problem.get("summary", "")) < 40:
        found.append("the summary is too short")
    if len(solution.get("root_cause", "")) < 30:
        found.append("the root cause is too short")
    if any(not a["approach"].strip() or a["approach"].strip() == "<path>" for a in problem.get("failed_approaches", [])):
        found.append("a dead end has no usable command")
    if any(c["command"].strip() in {"", "<path>", "<project>"} for c in solution.get("shell_commands_executed", [])):
        found.append("a command was reduced to a placeholder")
    return found


def trail(task: Task) -> dict:
    failed = [run(task, task.failing_command)] + [run(task, x) for x in task.failed_approaches]
    fixed = run(task, f"{task.fix_command}; echo {VERIFY_MARK}; {task.verification_command}")
    logs = "\n\n".join((x["stderr"] or x["stdout"] or "(no output)") for x in failed)
    message = error_line(logs, task.error_type, MESSAGE_OVERRIDES.get(task.task_id, ""))
    candidate = {
        "protocol_version": "1.0",
        "agent_info": {"model": "seed-factory", "framework": "myrmo-seed"},
        "environment": {"os": "linux", "os_version": "container", "arch": "x86_64", "container": "docker", "runtime": task.runtime, "packages": [{"name": task.image, "ecosystem": "other"}]},
        "problem": {"error_type": task.error_type, "error_message": message, "summary": task.summary, "task_context": task.context, "raw_logs": logs[:16000], "category": task.category, "failed_approaches": [{"approach": x["command"], "why_it_failed": (x["stderr"] or x["stdout"] or "command failed")[:500]} for x in failed[1:] if x["exit_code"] != 0]},
        "solution": {"root_cause": task.root_cause, "steps": list(task.steps), "shell_commands_executed": [{"command": task.fix_command, "purpose": "Apply the reproduced fix.", "shell": "sh", "exit_code": 0 if fixed["exit_code"] == 0 else fixed["exit_code"]}, {"command": task.verification_command, "purpose": "Verify the fix with real command output.", "shell": "sh", "exit_code": 0 if fixed["exit_code"] == 0 else fixed["exit_code"]}], "code_patches": [], "verification_method": {"type": "command_exit_zero", "description": "The corrected command and verification command completed successfully in the same fixed image.", "command": task.verification_command, "evidence": verification_evidence(fixed)}},
        "effort": {"failed_attempts": sum(x["exit_code"] != 0 for x in failed), "wall_time_seconds": round(sum(x["seconds"] for x in failed) + fixed["seconds"], 3)},
        "tags": ["seed-factory", BATCH, *task.tags],
        "_factory": {"task_id": task.task_id, "failed": failed, "fixed": fixed},
    }
    cleaned = clean(candidate)
    global FACTORY_VERSION
    FACTORY_VERSION = FACTORY_VERSION or provenance.factory_version()
    cleaned["_provenance"] = provenance.record(
        task_id=task.task_id, batch=BATCH, image=task.image, digest=provenance.image_digest(task.image), version=FACTORY_VERSION,
        public_trail={k: v for k, v in cleaned.items() if not k.startswith("_")},
    )
    return cleaned


def validate(candidate: dict) -> None:
    public = {k: v for k, v in candidate.items() if not k.startswith("_")}
    errors = sorted(Draft7Validator(SCHEMA).iter_errors(public), key=lambda e: list(e.path))
    if errors:
        raise ValueError(f"{candidate['_factory']['task_id']}: {errors[0].message}")
    problems = quality_problems(candidate)
    if problems:
        raise ValueError(f"{candidate['_factory']['task_id']}: {'; '.join(problems)}")
    if candidate["effort"]["failed_attempts"] < 1:
        raise ValueError("a trail must contain a real failed attempt")
    if candidate["_factory"]["fixed"]["exit_code"] != 0:
        raise ValueError("the fix and verification did not exit successfully")
    if any(attempt["exit_code"] == 0 for attempt in candidate["_factory"]["failed"]):
        raise ValueError("a failed approach exited successfully")
    problems = provenance.check(candidate.get("_provenance"))
    if problems:
        raise ValueError(f"{candidate['_factory']['task_id']}: {'; '.join(problems)}")
    candidate["fingerprint"] = fingerprint(candidate["environment"]["runtime"]["name"], candidate["problem"]["error_type"], candidate["problem"]["error_message"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--batch", default="pilot-001")
    parser.add_argument("--output", default=str(OUT / "pilot.jsonl"))
    parser.add_argument("--include-excluded", action="store_true", help="also run tasks the publication policy excludes (for tests)")
    args = parser.parse_args()
    global BATCH
    BATCH = args.batch
    OUT.mkdir(exist_ok=True)
    results = []
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, args.limit)) as pool:
        pool_tasks = TASKS if args.include_excluded else publishable()
        selected = pool_tasks[args.start : args.start + args.limit]
        # Fetch each image once, before the workers start, so no task sees a download in its output.
        for image in sorted({task.image for task in selected}):
            subprocess.run(["docker", "pull", "-q", image], capture_output=True, text=True)
        futures = {pool.submit(trail, task): task for task in selected}
        for future in as_completed(futures):
            try:
                candidate = future.result()
            except Exception as exc:  # a task whose setup failed, or Docker itself: record it and go on
                results.append({"_factory": {"task_id": futures[future].task_id, "valid": False, "validation_error": str(exc)}})
                continue
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
