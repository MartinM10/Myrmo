"""MyrmoBench: does following a trail help an agent fix a real breakage?

    python bench/myrmobench/run.py list                    # the tasks
    python bench/myrmobench/run.py plan                    # how many runs, with which models, what they would cost
    python bench/myrmobench/run.py dry-run                 # build every task, prove it fails, prove its fix passes
    python bench/myrmobench/run.py run --execute --approved-usd 40 ...   # spends money: see below

Nothing here calls a paid API unless `run` is given `--execute` AND `--approved-usd`, the most the person who pays has
agreed to spend. `plan` prints the number to approve. `dry-run` only needs Docker (and the network to build images).

The protocol (docs/operate/benchmarks.md):
  1. A pioneer agent solves each task cold, with publishing on, against an empty colony.
  2. Follower agents solve each task twice: without Myrmo, and with Myrmo connected to the colony the pioneer filled.
  3. A hidden check.sh decides success. It is copied into the container only after the agent has finished.
Metrics per run: success, tokens (all of them: input, output and cache), cost as the agent CLI reports it, failed
attempts (failed tool calls) and wall time. Raw runs are kept in bench/results/myrmobench-<id>/runs.jsonl.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TASKS_DIR = HERE / "tasks"
RESULTS = ROOT / "bench" / "results"

CLAUDE_CODE_VERSION = "latest"  # pinned in the run's environment.json; `latest` is resolved when the image is built
MCP_VERSION_FILE = ROOT / "clients/typescript/packages/myrmo-mcp/package.json"

#: USD per million tokens (input, output), from the published prices of the models. Cache reads are not priced here: the
#: estimate is a ceiling, and a run reports the cost its own CLI computed.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
}
#: What one run of an agent on one of these small tasks is expected to use. A guess, to be replaced by the first
#: measured run: generous on purpose, so that the number to approve is a ceiling.
TOKENS_PER_RUN = {"input": 600_000, "output": 30_000}


# --- tasks -----------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Task:
    id: str
    title: str
    image_tag: str
    prompt: str
    error_line: str
    max_minutes: int
    symptom: str
    symptom_match: str
    ready: str
    path: Path = field(compare=False)

    @property
    def agent_tag(self) -> str:
        return f"{self.image_tag}-agent"


def load_tasks(only: list[str] | None = None) -> list[Task]:
    tasks = []
    for path in sorted(TASKS_DIR.glob("*/task.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        task = Task(path=path.parent, **{k: d[k] for k in (
            "id", "title", "image_tag", "prompt", "error_line", "max_minutes", "symptom", "symptom_match", "ready")})
        for name in ("Dockerfile", "check.sh", "solution.sh"):
            if not (task.path / name).is_file():
                raise SystemExit(f"task {task.id}: {name} is missing")
        if only and task.id not in only:
            continue
        tasks.append(task)
    if only and {t.id for t in tasks} != set(only):
        raise SystemExit(f"unknown task in {only}; known: {[p.parent.name for p in TASKS_DIR.glob('*/task.json')]}")
    return tasks


# --- the plan ---------------------------------------------------------------------------------------------------------

def plan(tasks: int, followers: list[str], pioneer: str, repetitions: int) -> dict:
    """Runs and the most they should cost. Per task: one pioneer run, then every follower `repetitions` times,
    without Myrmo and with it."""
    runs = {"pioneer": {pioneer: tasks}}
    runs["followers"] = {m: tasks * repetitions * 2 for m in followers}
    per_run = lambda model: (TOKENS_PER_RUN["input"] * PRICES[model][0] + TOKENS_PER_RUN["output"] * PRICES[model][1]) / 1e6
    cost = per_run(pioneer) * tasks + sum(per_run(m) * n for m, n in runs["followers"].items())
    total = tasks + sum(runs["followers"].values())
    return {"tasks": tasks, "runs": total, "by_role": runs, "estimated_usd_ceiling": round(cost, 2),
            "per_run_usd": {m: round(per_run(m), 2) for m in {pioneer, *followers}}}


# --- results ----------------------------------------------------------------------------------------------------------

def parse_claude_stream(text: str) -> dict:
    """Metrics from `claude -p --output-format stream-json --verbose`: one JSON object per line. Failed attempts are
    tool calls that came back as errors; tokens and cost come from the final `result` line."""
    failed, result = 0, {}
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "user":
            for part in (event.get("message") or {}).get("content") or []:
                if isinstance(part, dict) and part.get("type") == "tool_result" and part.get("is_error"):
                    failed += 1
        elif event.get("type") == "result":
            result = event
    usage = result.get("usage") or {}
    tokens = sum(int(usage.get(k) or 0) for k in (
        "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return {"tokens": tokens, "cost_usd": float(result.get("total_cost_usd") or 0.0), "turns": int(result.get("num_turns") or 0),
            "failed_attempts": failed, "agent_error": bool(result.get("is_error")) or not result}


def summarize(runs: list[dict]) -> dict:
    """Per condition (`without` or `with` Myrmo): success rate and medians over the follower runs."""
    out = {}
    for condition in ("without", "with"):
        rows = [r for r in runs if r["role"] == "follower" and r["condition"] == condition]
        if not rows:
            continue
        med = lambda key: statistics.median(r[key] for r in rows)
        out[condition] = {"runs": len(rows), "success_rate": round(sum(r["success"] for r in rows) / len(rows), 3),
                          "median_tokens": med("tokens"), "median_failed_attempts": med("failed_attempts"),
                          "median_seconds": round(med("seconds"), 1), "median_cost_usd": round(med("cost_usd"), 4)}
    return out


# --- docker -----------------------------------------------------------------------------------------------------------

def sh(*args: str, check: bool = True, timeout: int | None = None, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=timeout, input=input_text)


def build(task: Task) -> None:
    sh("docker", "build", "-t", task.image_tag, str(task.path))


def start(task: Task, image: str, extra: tuple[str, ...] = ()) -> str:
    name = f"myrmobench-{task.id}-{uuid.uuid4().hex[:8]}"
    sh("docker", "run", "-d", "--name", name, *extra, image)
    for _ in range(60):
        if sh("docker", "exec", name, "sh", "-c", task.ready, check=False).returncode == 0:
            return name
        time.sleep(1)
    sh("docker", "rm", "-f", name, check=False)
    raise RuntimeError(f"{task.id}: the container did not become ready")


def stop(name: str) -> None:
    sh("docker", "rm", "-f", name, check=False)


def check(task: Task, name: str) -> tuple[bool, str]:
    """The hidden check, copied in only now."""
    sh("docker", "cp", str(task.path / "check.sh"), f"{name}:/tmp/check.sh")
    done = sh("docker", "exec", name, "sh", "/tmp/check.sh", check=False, timeout=300)
    sh("docker", "exec", name, "rm", "-f", "/tmp/check.sh", check=False)
    last = (done.stdout.strip().splitlines() or [""])[-1]
    return last == "PASS", last


# --- dry run ----------------------------------------------------------------------------------------------------------

def dry_run_one(task: Task) -> list[str]:
    """Problems with a task; an empty list means it can be used: it fails as described, its check says so, and the
    reference fix makes the check pass."""
    problems = []
    build(task)
    name = start(task, task.image_tag)
    try:
        symptom = sh("docker", "exec", name, "sh", "-c", task.symptom + " 2>&1", check=False, timeout=300)
        if symptom.returncode == 0 or not re.search(task.symptom_match, symptom.stdout, re.I):
            problems.append(f"the symptom is not the expected one (exit {symptom.returncode}): {symptom.stdout.strip()[-200:]!r}")
        passed, why = check(task, name)
        if passed:
            problems.append("the check passes before anything is fixed")
        sh("docker", "cp", str(task.path / "solution.sh"), f"{name}:/tmp/solution.sh")
        fix = sh("docker", "exec", name, "sh", "/tmp/solution.sh", check=False, timeout=600)
        if fix.returncode != 0:
            problems.append(f"the reference fix fails: {(fix.stdout + fix.stderr).strip()[-200:]!r}")
        passed, why = check(task, name)
        if not passed:
            problems.append(f"the check still fails after the reference fix: {why}")
    finally:
        stop(name)
    return problems


# --- real runs --------------------------------------------------------------------------------------------------------

def mcp_config(colony: str, publish: str, agent_id: str) -> dict:
    version = json.loads(MCP_VERSION_FILE.read_text(encoding="utf-8"))["version"]
    return {"mcpServers": {"myrmo": {"command": "npx", "args": ["-y", f"myrmo-mcp@{version}"],
            "env": {"MYRMO_URL": colony, "MYRMO_PUBLISH": publish, "MYRMO_AGENT_ID": agent_id, "MYRMO_MIN_FAILED_ATTEMPTS": "1"}}}}


def claude_command(task: Task, model: str, with_myrmo: bool) -> list[str]:
    allowed = "Bash,Read,Edit,Write,Glob,Grep" + (",mcp__myrmo" if with_myrmo else "")
    command = ["claude", "-p", task.prompt, "--model", model, "--output-format", "stream-json", "--verbose",
               "--allowedTools", allowed, "--max-turns", "60"]
    if with_myrmo:
        command += ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"]
    else:
        command += ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    return command


def run_agent(task: Task, model: str, role: str, condition: str, colony: str, repetition: int, env: list[str]) -> dict:
    """One run: a fresh container from the agent image, the agent works in it, the hidden check decides."""
    with_myrmo = condition == "with"
    # Reach the colony on the host from inside the container.
    name = start(task, task.agent_tag, ("--add-host", "host.docker.internal:host-gateway"))
    started = time.time()
    try:
        if with_myrmo:
            cfg = mcp_config(colony.replace("localhost", "host.docker.internal"), "auto" if role == "pioneer" else "off",
                             f"bench-{role}-{uuid.uuid4().hex[:8]}")
            sh("docker", "exec", "-i", name, "sh", "-c", "cat > /tmp/mcp.json", input_text=json.dumps(cfg))
        exec_env = [x for e in env for x in ("-e", e)]
        done = sh("docker", "exec", *exec_env, name, *claude_command(task, model, with_myrmo),
                  check=False, timeout=task.max_minutes * 60)
        seconds = time.time() - started
        passed, why = check(task, name)
        metrics = parse_claude_stream(done.stdout)
        return {"task": task.id, "model": model, "role": role, "condition": condition, "repetition": repetition,
                "success": passed, "check": why, "seconds": round(seconds, 1), **metrics}
    except subprocess.TimeoutExpired:
        return {"task": task.id, "model": model, "role": role, "condition": condition, "repetition": repetition,
                "success": False, "check": "timeout", "seconds": task.max_minutes * 60, "tokens": 0, "cost_usd": 0.0,
                "turns": 0, "failed_attempts": 0, "agent_error": True}
    finally:
        stop(name)


def cmd_run(args: argparse.Namespace) -> int:
    tasks = load_tasks(args.tasks)
    p = plan(len(tasks), args.followers, args.pioneer, args.repetitions)
    if not args.execute or args.approved_usd is None:
        print(json.dumps(p, indent=2))
        print("\nNothing was run. This spends money: add --execute and --approved-usd <the most you accept to spend>.")
        return 2
    if args.approved_usd < p["estimated_usd_ceiling"]:
        print(f"The plan's ceiling is ${p['estimated_usd_ceiling']} and you approved ${args.approved_usd}. Raise it or run less.")
        return 2
    import os
    env = [f"{k}={os.environ[k]}" for k in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN") if os.environ.get(k)]
    if not env:
        print("Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.")
        return 2
    run_id = "myrmobench-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    out = RESULTS / run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "environment.json").write_text(json.dumps({"plan": p, "colony": args.colony, "pioneer": args.pioneer,
                                                      "followers": args.followers, "claude_code": args.claude_code_version}, indent=2))
    spent, runs = 0.0, []
    for task in tasks:
        build(task)
        sh("docker", "build", "-t", task.agent_tag, "-f", str(HERE / "agent.Dockerfile"), "--build-arg", f"BASE={task.image_tag}",
           "--build-arg", f"CLAUDE_CODE_VERSION={args.claude_code_version}", str(HERE))
        plan_for_task = [(args.pioneer, "pioneer", "with", 0)] + [
            (m, "follower", c, r) for m in args.followers for r in range(args.repetitions) for c in ("without", "with")]
        for model, role, condition, rep in plan_for_task:
            if spent >= args.approved_usd:
                print(f"Stopped: ${spent:.2f} spent of ${args.approved_usd} approved.")
                break
            row = run_agent(task, model, role, condition, args.colony, rep, env)
            spent += row["cost_usd"]
            runs.append(row)
            with (out / "runs.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{task.id:18} {model:18} {role:8} {condition:8} {'PASS' if row['success'] else 'FAIL'} "
                  f"{row['tokens']:>9} tokens ${row['cost_usd']:.3f}")
    (out / "summary.json").write_text(json.dumps(summarize(runs), indent=2))
    print(f"\n${spent:.2f} spent. Results in {out.relative_to(ROOT)}; publish with publish_results.py.")
    return 0


# --- cli --------------------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "plan", "dry-run", "run"):
        s = sub.add_parser(name)
        s.add_argument("--tasks", nargs="*", help="only these task ids")
        if name in ("plan", "run"):
            s.add_argument("--pioneer", default="claude-opus-5-5", choices=sorted(PRICES))
            s.add_argument("--followers", nargs="+", default=["claude-sonnet-5-5"], choices=sorted(PRICES))
            s.add_argument("--repetitions", type=int, default=5)
        if name == "run":
            s.add_argument("--execute", action="store_true", help="really run the agents (spends money)")
            s.add_argument("--approved-usd", type=float, help="the most the person who pays accepts to spend")
            s.add_argument("--colony", default="http://localhost:8080", help="an empty colony for the run")
            s.add_argument("--claude-code-version", default=CLAUDE_CODE_VERSION)
    args = parser.parse_args(argv)
    if args.command == "list":
        for t in load_tasks(args.tasks):
            print(f"{t.id:18} {t.title}")
        return 0
    if args.command == "plan":
        print(json.dumps(plan(len(load_tasks(args.tasks)), args.followers, args.pioneer, args.repetitions), indent=2))
        return 0
    if args.command == "dry-run":
        failed = 0
        for task in load_tasks(args.tasks):
            problems = dry_run_one(task)
            print(f"{'ok  ' if not problems else 'FAIL'} {task.id}" + ("" if not problems else "\n     " + "\n     ".join(problems)))
            failed += bool(problems)
        return 1 if failed else 0
    return cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
