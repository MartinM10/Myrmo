"""Turn breakage leads into seed tasks with an agent that reproduces each one in the task's own image.

    python tools/seed-factory/worker.py --limit 3                  # the first leads of candidates/_radar.json
    python tools/seed-factory/worker.py --lead npm:typescript:7.0.2 --signal esm-only
    python tools/seed-factory/worker.py --limit 5 --models gpt-oss-120b-medium gemini-3.1-pro-high

For each lead the Antigravity CLI (agy, on the plan of the person who signed in to the myrmobench-agy volume, see
docs/operate/benchmarks.md) runs inside a container built from the task's base image. It installs the pinned versions,
makes the error happen, tries the obvious fixes that do not work, finds the one that does, and writes a draft task
(drafts/<task_id>.json) or a reason to skip the lead. The factory then runs the draft in a fresh container with its
quality gates; when they refuse it, the agent gets the reason and one more attempt. Nothing is published: a draft that
passes becomes a trail in seed-out/ for a person to review, and publisher.py publishes it later at its paced rate.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DRAFTS = HERE / "drafts"
RADAR = HERE / "candidates" / "_radar.json"
SEED_OUT = ROOT / "seed-out"
AGY_DIR = ROOT / "bench" / "myrmobench" / "agy"
AGY_VOLUME = "myrmobench-agy"
#: Cheapest first. The factory's gates judge every draft by running it, so a weaker model cannot pass a bad one: it only
#: costs an attempt, and the next model gets the reason it was refused.
DEFAULT_MODELS = ("gemini-3.8-flash-low", "gpt-oss-120b-medium", "gemini-3.1-pro-high")
MINUTES = 20
MCP_PACKAGE = ROOT / "clients/typescript/packages/myrmo-mcp"

#: The base image a lead is reproduced in. A raised runtime floor needs the runtime just below it.
def base_image(lead: dict) -> str:
    if lead["ecosystem"] == "npm":
        floor = re.search(r"requires Node (\d+)", lead.get("detail", ""))
        major = int(floor.group(1)) - 2 if floor and lead["signal"] == "runtime-floor" else 20
        return f"node:{max(major, 18)}-bookworm-slim"
    floor = re.search(r"requires Python 3\.(\d+)", lead.get("detail", ""))
    minor = int(floor.group(1)) - 1 if floor and lead["signal"] == "runtime-floor" else 12
    return f"python:3.{max(minor, 9)}-slim-bookworm"


def task_id(lead: dict) -> str:
    raw = f"radar-{lead['ecosystem']}-{lead['package']}-{lead['version']}-{lead['signal']}"
    return re.sub(r"[^a-z0-9.-]+", "-", raw.lower()).strip("-")[:80]


PROMPT = """You are preparing a reproducible seed task for Myrmo, a shared memory of errors that AI agents look up.

THE LEAD (from the package registry, {released}): {ecosystem} package `{package}` {version}: {signal} ({detail}).
You are inside a fresh container of the image `{image}`. Network access is available.

GOAL: find out whether this release breaks something real that developers or agents will hit, reproduce it here, and
write a task file. Work by running commands; never guess an error message: every message in the task must be one you saw.

1. Install pinned versions (exact versions, never "latest") in a working directory /w and make the error happen with
   one command. Typical: a common tool or library that depends on `{package}` stops working, an install fails on this
   runtime, an import or require fails.
2. Try two plausible fixes that do NOT work (for example the first thing an agent would try), and see them fail.
3. Find the fix that works and a command that verifies it (exit code 0).
4. Re-run everything from scratch in a new directory to be sure it reproduces.

WRITE /out/task.json with exactly these fields (JSON, UTF-8):
  "task_id": "{task_id}",
  "image": "{image}",
  "runtime": {{"name": "...", "version": "..."}},
  "category": one of dependency, build, runtime, configuration, network, authentication, permissions, api_contract, data, concurrency, tooling, platform, other,
  "error_type": the exception class or error code (short),
  "summary": 1-2 sentences, 20+ characters: what breaks and why it is surprising,
  "context": what the developer was doing,
  "setup": shell commands that prepare /w (create files, pinned installs); its output is hidden; must exit 0,
  "failing_command": a command run after setup, from any directory, that exits non-zero and prints the error (use `cd /w && ... 2>&1`),
  "failed_approaches": [two commands, each run after setup in a fresh container, that try a plausible fix and still exit non-zero],
  "fix_command": the command that applies the fix (run after setup in a fresh container),
  "verification_command": a command that exits 0 once the fix is applied,
  "root_cause": 2-3 sentences, 10+ characters,
  "steps": ["short, general steps another developer can follow"],
  "tags": ["lowercase", "keywords"]
Each command runs with `sh -c` in a NEW container of {image} right after `setup`, so it must not rely on anything another
command did. Use only POSIX sh. No placeholders like <path>. Keep commands short.

QUALITY, or the task is refused at review even if it runs:
- The fix is the one the package's authors intend (a supported runtime, the last compatible version, the renamed option),
  never a workaround that forces an unsupported combination (--force, --legacy-peer-deps, ignoring engines).
- The verification exercises the real use (run the tool or the test it is for), not only an import or a --version.
- root_cause states only what you observed or what the release notes say; no guesses about internals.
- steps are general advice another developer can follow, not a log of what you did here.

MYRMO: the myrmo MCP server is connected (the public colony). Use it for every error you hit while you work, as your
rules in GEMINI.md say: search before you try a fix, report what a trail did for you. Do NOT publish the breakage of this
lead yourself: the seed factory publishes it once it has verified your task. Do publish any other hard error of tooling,
versions or environment that you solve on the way, if the colony did not have it.

SKIP instead (write /out/task.json as {{"skip": "<reason>"}}) when: the release breaks nothing you can reproduce; the error
is one a capable developer fixes at a glance; the fix depends on the user's own code rather than versions or configuration;
or it needs something a container cannot provide.
"""

RETRY = """
YOUR PREVIOUS DRAFT was run by the seed factory in fresh containers and refused for this reason:
  {error}
The draft was:
{draft}
Fix the draft (run the commands again here to check) and write /out/task.json again, or a skip with the reason.
"""


def sh(*args: str, check: bool = True, timeout: int | None = None, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", check=check,
                          timeout=timeout, input=input_text)


_RULES: list[str] = []


def myrmo_setup(model: str) -> tuple[dict, str]:
    """The myrmo MCP server for the agent (public colony, publishing on) and the usage rules `npx myrmo-mcp init` writes
    to ~/.gemini/GEMINI.md. Antigravity passes neither the server's instructions nor its tool names to the model, so
    without the rules the agent would never use it."""
    if not _RULES:
        dist = (MCP_PACKAGE / "dist" / "init.js").as_uri()
        done = sh("node", "-e", f"import({json.dumps(dist)}).then(m => process.stdout.write(m.AGENTS_BLOCK))", check=False)
        if "myrmo:start" not in done.stdout:
            raise SystemExit("Build the MCP server first (cd clients/typescript && npm ci && npm run build).")
        _RULES.append(done.stdout)
    version = json.loads((MCP_PACKAGE / "package.json").read_text(encoding="utf-8"))["version"]
    agent_id = re.sub(r"[^A-Za-z0-9_-]", "-", f"seed-worker-{model}")[:64]
    server = {"command": "npx", "args": ["-y", f"myrmo-mcp@{version}"],
              "env": {"MYRMO_PUBLISH": "auto", "MYRMO_AGENT_ID": agent_id, "MYRMO_AGENT_MODEL": model}}
    return {"mcpServers": {"myrmo": server}}, _RULES[0]


def worker_image(base: str) -> str:
    """The base image with agy in it (the same image MyrmoBench uses for Antigravity runs)."""
    tag = "myrmo-seed-worker:" + re.sub(r"[^a-z0-9.-]+", "-", base.lower())
    if sh("docker", "image", "inspect", tag, check=False).returncode != 0:
        sh("docker", "build", "-t", "myrmobench/agy", str(AGY_DIR))
        sh("docker", "build", "-t", tag, "-f", str(AGY_DIR / "agent.Dockerfile"), "--build-arg", f"BASE={base}", str(AGY_DIR))
    return tag


def draft(lead: dict, model: str, retry: str = "") -> tuple[dict | None, dict]:
    """Run the agent on one lead; returns (the task.json it wrote or None, metrics)."""
    image = base_image(lead)
    tid = task_id(lead)
    prompt = PROMPT.format(task_id=tid, image=image, **lead) + retry
    name = f"seed-worker-{tid[:40]}-{int(time.time())}"
    sh("docker", "run", "-d", "--name", name, "-v", f"{AGY_VOLUME}:/seed:ro", "--entrypoint", "sleep", worker_image(image), "infinity")
    started = time.time()
    try:
        sh("docker", "exec", name, "sh", "-c", "mkdir -p /root/.gemini /out && cp -r /seed/. /root/.gemini/")
        sh("docker", "exec", "-i", name, "sh", "-c", "cat > /tmp/prompt.md", input_text=prompt)
        mcp, rules = myrmo_setup(model)
        sh("docker", "exec", "-i", name, "sh", "-c", "mkdir -p /root/.gemini/config && cat > /root/.gemini/config/mcp_config.json",
           input_text=json.dumps(mcp))
        sh("docker", "exec", "-i", name, "sh", "-c", "cat > /root/.gemini/GEMINI.md", input_text=rules)
        done = sh("docker", "exec", name, "sh", "-c",
                  f'cd /tmp && agy -p "$(cat /tmp/prompt.md)" --model {model} --output-format stream-json --dangerously-skip-permissions',
                  check=False, timeout=MINUTES * 60)
        out = sh("docker", "exec", name, "cat", "/out/task.json", check=False)
        tokens = 0
        for line in done.stdout.splitlines():
            if '"event":"result"' in line.replace(" ", ""):
                try:
                    tokens = int(json.loads(line)["result"]["usage"]["total_tokens"])
                except (ValueError, KeyError):
                    pass
        metrics = {"seconds": round(time.time() - started), "tokens": tokens}
        try:
            return json.loads(out.stdout), metrics
        except ValueError:
            return None, metrics
    except subprocess.TimeoutExpired:
        return None, {"seconds": MINUTES * 60, "tokens": 0, "timeout": True}
    finally:
        sh("docker", "rm", "-f", name, check=False)


def run_factory(tid: str, batch: str) -> tuple[bool, str]:
    """Run one draft through the factory's gates; returns (valid, reason)."""
    # One output per task: the factory rewrites its output file, so a shared one kept only the last task's result.
    output = SEED_OUT / f"{batch}-{tid}.jsonl"
    done = sh(sys.executable, str(HERE / "factory.py"), "--ids", tid, "--limit", "1", "--batch", batch,
              "--output", str(output), check=False, timeout=1800)
    try:
        summary = json.loads(done.stdout[done.stdout.index("{"):])
    except ValueError:
        return False, (done.stderr or done.stdout)[-600:]
    invalid = summary.get("invalid") or []
    valid = not invalid and summary.get("valid_unique") == 1
    if valid:
        # The batch's file gathers every valid trail, for review and for publisher.py.
        with (SEED_OUT / f"{batch}.jsonl").open("a", encoding="utf-8") as f:
            f.write(output.read_text(encoding="utf-8").strip() + "\n")
    return valid, (invalid[0]["reason"] if invalid else "")


def work(lead: dict, models: list[str], batch: str) -> dict:
    """Up the ladder of models until a draft passes the factory. A skip or a refusal from a weaker model is not the
    last word: the next one tries, told why; only the last model's skip ends the lead."""
    tid = task_id(lead)
    path = DRAFTS / f"{tid}.json"
    result = {"task_id": tid, "lead": lead, "attempts": []}
    retry = ""
    for model in models:
        task, metrics = draft(lead, model, retry)
        metrics["model"] = model
        if task is None:
            result["attempts"].append({**metrics, "outcome": "no task.json"})
            retry = ""
            continue
        if "skip" in task:
            result["attempts"].append({**metrics, "outcome": "skip", "reason": task["skip"]})
            retry = f"\nANOTHER AGENT skipped this lead with this reason; check it yourself before agreeing: {task['skip']}\n"
            continue
        task.update({"task_id": tid, "ecosystem": "radar", "written_by_model": model,
                     "_lead": lead, "_drafted_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        DRAFTS.mkdir(exist_ok=True)
        path.write_text(json.dumps(task, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        valid, reason = run_factory(tid, batch)
        result["attempts"].append({**metrics, "outcome": "valid" if valid else "refused", "reason": reason})
        if valid:
            break
        retry = RETRY.format(error=reason, draft=json.dumps({k: v for k, v in task.items() if not k.startswith("_")}, indent=1))
    if result["attempts"] and result["attempts"][-1]["outcome"] != "valid":
        path.unlink(missing_ok=True)  # no draft the factory refused is left behind for the next run to trip over
    result["outcome"] = result["attempts"][-1]["outcome"] if result["attempts"] else "nothing"
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--signal", action="append", help="only leads with this signal (repeatable)")
    parser.add_argument("--lead", help="one lead as ecosystem:package:version (with --signal); else the radar's")
    parser.add_argument("--models", nargs="+", default=list(DEFAULT_MODELS), help="tried in order, cheapest first")
    parser.add_argument("--batch", default="radar-" + datetime.now(timezone.utc).strftime("%Y%m%d"))
    args = parser.parse_args(argv)
    if args.lead:
        eco, package, version = args.lead.split(":")
        leads = [{"ecosystem": eco, "package": package, "version": version, "signal": (args.signal or ["major"])[0],
                  "detail": "", "released": "", "source": ""}]
    else:
        leads = json.loads(RADAR.read_text(encoding="utf-8"))["leads"]
        if args.signal:
            leads = [l for l in leads if l["signal"] in args.signal]
        done = {p.stem for p in DRAFTS.glob("*.json")} if DRAFTS.is_dir() else set()
        leads = [l for l in leads if task_id(l) not in done][args.start : args.start + args.limit]
    log = SEED_OUT / f"{args.batch}-worker.jsonl"
    SEED_OUT.mkdir(exist_ok=True)
    for lead in leads:
        result = work(lead, args.models, args.batch)
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(result) + "\n")
        last = result["attempts"][-1] if result["attempts"] else {}
        print(f"{result['task_id']:60} {result['outcome']:8} by {last.get('model', '-')}: {last.get('reason', '')[:110]}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
