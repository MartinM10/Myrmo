"""MyrmoBench: does following a trail help an agent fix a real breakage?

    python bench/myrmobench/run.py list                    # the tasks
    python bench/myrmobench/run.py plan                    # how many runs, with which models, what they would cost
    python bench/myrmobench/run.py dry-run                 # build every task, prove it fails, prove its fix passes
    python bench/myrmobench/run.py seed --from https://myrmo.dev        # copy the public trails into the local colony
    python bench/myrmobench/run.py run --execute --approved-usd 40 ...   # spends money: see below

Nothing here calls a paid API unless `run` is given `--execute` AND `--approved-usd`, the most the person who pays has
agreed to spend. `plan` prints the number to approve. `dry-run` only needs Docker (and the network to build images).
`seed` only reads the public colony and writes to the local one.

The protocol (docs/operate/benchmarks.md). Follower agents solve each task in three conditions:
  without   no Myrmo.
  unseen    Myrmo connected, but the colony has not seen this task's fix: it holds what it held before the run (the
            public trails, after `seed`, or nothing). This is what an agent gets today for an error the colony does
            not know, and it prices the cost of Myrmo when it cannot help: the instructions, a search, a wrong trail.
  with      Myrmo connected, after a pioneer agent has solved the task with publishing on and left its trail.
Every `without` and `unseen` run happens before any pioneer runs, so no pioneer's trail can leak into them. A hidden
check.sh decides success; it is copied into the container only after the agent has finished.
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
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TASKS_DIR = HERE / "tasks"
RESULTS = ROOT / "bench" / "results"

CLAUDE_CODE_VERSION = "latest"  # pinned in the run's environment.json; `latest` is resolved when the image is built
OPENCODE_VERSION = "latest"
GEMINI_VERSION = "latest"
AGENTS = ("claude-code", "opencode", "gemini", "antigravity")
#: The follower conditions, in the order they are reported. See the module docstring.
CONDITIONS = ("without", "unseen", "with")
MCP_VERSION_FILE = ROOT / "clients/typescript/packages/myrmo-mcp/package.json"

#: USD per million tokens (input, output), from the published prices of the models. Cache reads are not priced here: the
#: estimate is a ceiling, and a run reports the cost its own CLI computed.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
}
#: USD per million tokens (input, output) assumed for a model that is not listed above, such as the `opencode-go/<id>`
#: ones: a deliberately high figure, so that the ceiling and the spending brake are never too low.
ASSUMED_PRICE = (3.0, 15.0)
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

    def agent_tag(self, agent: str = "claude-code") -> str:
        return f"{self.image_tag}-agent" + ("" if agent == "claude-code" else f"-{agent}")


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

def price_of(model: str) -> tuple[float, float]:
    return PRICES.get(model, ASSUMED_PRICE)


def plan(tasks: int, followers: list[str], pioneer: str, repetitions: int,
         conditions: tuple[str, ...] = CONDITIONS) -> dict:
    """Runs and the most they should cost. Per task: every follower `repetitions` times in each condition, and one
    pioneer run when the `with` condition is wanted."""
    pioneers = tasks if "with" in conditions else 0
    runs = {"pioneer": {pioneer: pioneers} if pioneers else {}}
    runs["followers"] = {m: tasks * repetitions * len(conditions) for m in followers}
    per_run = lambda model: (TOKENS_PER_RUN["input"] * price_of(model)[0] + TOKENS_PER_RUN["output"] * price_of(model)[1]) / 1e6
    cost = per_run(pioneer) * pioneers + sum(per_run(m) * n for m, n in runs["followers"].items())
    total = pioneers + sum(runs["followers"].values())
    return {"tasks": tasks, "runs": total, "conditions": list(conditions), "by_role": runs,
            "estimated_usd_ceiling": round(cost, 2),
            "per_run_usd": {m: round(per_run(m), 2) for m in ({pioneer} if pioneers else set()) | set(followers)}}


def schedule(task_ids: list[str], pioneer: str, followers: list[str], repetitions: int,
             conditions: tuple[str, ...] = CONDITIONS) -> list[dict]:
    """The runs in the order they happen. First every `without` and `unseen` run of every task, alternating so that a
    slow hour of the model's API does not fall on one condition; then the pioneers; then the `with` runs. No pioneer's
    trail is in the colony while a run that must not see it is going on."""
    before = [c for c in ("without", "unseen") if c in conditions]
    out = [{"task": t, "model": m, "role": "follower", "condition": c, "repetition": r}
           for t in task_ids for r in range(repetitions) for m in followers for c in before]
    if "with" in conditions:
        out += [{"task": t, "model": pioneer, "role": "pioneer", "condition": "with", "repetition": 0} for t in task_ids]
        out += [{"task": t, "model": m, "role": "follower", "condition": "with", "repetition": r}
                for t in task_ids for r in range(repetitions) for m in followers]
    return out


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


def parse_opencode_events(text: str) -> dict:
    """Metrics from `opencode run --format json`: one JSON event per line (`step_start`, `text`, `reasoning`, `tool_use`,
    `step_finish`, `error`), each with a `part`. A failed attempt is a `tool_use` whose state is `error`; tokens and cost
    are summed over the `step_finish` parts, one per model step. A run with no step finished, or with an `error` event,
    counts as an agent error."""
    failed = steps = 0
    tokens, cost, errored = 0, 0.0, False
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        kind = event.get("type")
        if kind == "tool_use" and (part.get("state") or {}).get("status") == "error":
            failed += 1
        elif kind == "step_finish":
            steps += 1
            used = part.get("tokens") or {}
            cache = used.get("cache") or {}
            tokens += sum(int(used.get(k) or 0) for k in ("input", "output", "reasoning")) + sum(
                int(cache.get(k) or 0) for k in ("read", "write"))
            cost += float(part.get("cost") or 0.0)
        elif kind == "error":
            errored = True
    return {"tokens": tokens, "cost_usd": cost, "turns": steps, "failed_attempts": failed, "agent_error": errored or steps == 0}


def summarize(runs: list[dict]) -> dict:
    """Per condition (`without`, `unseen`, `with`): success rate and medians over the follower runs."""
    out = {}
    for condition in CONDITIONS:
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
    # The containers print UTF-8. Without an explicit encoding, Windows decodes with its ANSI code page, fails on the first
    # character outside it (agy prints ✓), and the run's output is lost.
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", check=check,
                          timeout=timeout, input=input_text)


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


# --- the local colony -------------------------------------------------------------------------------------------------

USER_AGENT = "myrmobench/1.0"


def http_json(url: str, body: dict | None = None, timeout: int = 60) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"user-agent": USER_AGENT, "content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read() or b"{}")


def public_trails(source: str) -> list[dict]:
    """Every trail a colony shows in its feed, as it was published (redacted). Read-only."""
    trails, cursor = [], None
    while True:
        query = urllib.parse.urlencode({"limit": "50", **({"cursor": cursor} if cursor else {})})
        page = http_json(f"{source.rstrip('/')}/v1/feed?{query}")
        trails += [item["trail"] for item in page.get("items", []) if isinstance(item.get("trail"), dict)]
        cursor = page.get("next_cursor")
        if not cursor:
            return trails


def colony_trails(colony: str) -> int:
    return int(http_json(f"{colony.rstrip('/')}/v1/stats").get("trails") or 0)


def wait_for_queue(colony: str, timeout: int = 600) -> bool:
    """Until the colony has indexed everything it was sent (or `timeout` seconds pass)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ready = http_json(f"{colony.rstrip('/')}/readyz", timeout=10)
        except urllib.error.HTTPError as err:  # 503 while a dependency starts
            ready = json.loads(err.read() or b"{}")
        except OSError:
            ready = {}
        if ready.get("ready") and int(ready.get("queue_depth") or 0) == 0:
            return True
        time.sleep(2)
    return False


def seed(source: str, colony: str) -> dict:
    """Copy the public trails of `source` into the (local) `colony`, so that a run searches a colony like the real one:
    the right trail is not the only one there, and a wrong one can come back. Production is only read."""
    if colony_trails(colony) > 0:
        raise SystemExit(f"{colony} already holds trails: seed an empty colony (docker compose down -v, then up).")
    trails = public_trails(source)
    accepted, refused = 0, []
    for trail in trails:
        try:
            http_json(f"{colony.rstrip('/')}/v1/trails", trail)
            accepted += 1
            time.sleep(0.6)  # under the colony's 120 requests per minute
        except urllib.error.HTTPError as err:
            refused.append(f"{err.code} {trail.get('problem', {}).get('error_type', '?')}")
    wait_for_queue(colony)
    return {"source": source, "read": len(trails), "accepted": accepted, "refused": refused, "indexed": colony_trails(colony)}


# --- real runs --------------------------------------------------------------------------------------------------------

def put(container: str, path: str, text: str) -> None:
    """Write a file inside the container, creating its folder; the text goes through stdin, never the command line."""
    sh("docker", "exec", "-i", container, "sh", "-c", f'mkdir -p "$(dirname {path})" && cat > {path}', input_text=text)


def mcp_config(colony: str, publish: str, agent_id: str) -> dict:
    version = json.loads(MCP_VERSION_FILE.read_text(encoding="utf-8"))["version"]
    return {"mcpServers": {"myrmo": {"command": "npx", "args": ["-y", f"myrmo-mcp@{version}"],
            "env": {"MYRMO_URL": colony, "MYRMO_PUBLISH": publish, "MYRMO_AGENT_ID": agent_id, "MYRMO_MIN_FAILED_ATTEMPTS": "1"}}}}


#: What an OpenCode agent may do: the same tools as the Claude Code runs, and no web. The container is the sandbox.
OPENCODE_PERMISSION = {"bash": "allow", "edit": "allow", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                       "webfetch": "deny", "websearch": "deny", "external_directory": "deny"}


def opencode_config(with_myrmo: bool, mcp: dict) -> dict:
    """The agent's whole configuration: no updates, no sharing, and Myrmo as the only MCP server when the run has it."""
    config = {"$schema": "https://opencode.ai/config.json", "autoupdate": False, "share": "disabled"}
    if with_myrmo:
        server = mcp["mcpServers"]["myrmo"]
        config["mcp"] = {"myrmo": {"type": "local", "command": [server["command"], *server["args"]],
                                   "environment": server["env"], "enabled": True}}
    return config


def opencode_command(task: Task, model: str) -> list[str]:
    return ["opencode", "run", task.prompt, "--model", model, "--format", "json"]


#: Gemini CLI's own web tools: off, as in the other agents' runs. The container is the sandbox.
GEMINI_EXCLUDED_TOOLS = ["google_web_search", "web_fetch"]
#: Where Gemini CLI keeps a Google sign-in (`gemini`, then "Sign in with Google"), on the host.
GEMINI_HOME = Path.home() / ".gemini"


def gemini_settings(with_myrmo: bool, mcp: dict, api_key: bool) -> dict:
    """Gemini CLI's settings: how it signs in, no web tools, and Myrmo as its only MCP server when the run has it. Both
    the current and the older names of the keys are written, so the file works across CLI versions."""
    auth = "gemini-api-key" if api_key else "oauth-personal"
    settings = {"security": {"auth": {"selectedType": auth}}, "selectedAuthType": auth,
                "tools": {"exclude": GEMINI_EXCLUDED_TOOLS}, "excludeTools": GEMINI_EXCLUDED_TOOLS,
                "privacy": {"usageStatisticsEnabled": False}, "usageStatisticsEnabled": False}
    settings["mcpServers"] = dict(mcp["mcpServers"]) if with_myrmo else {}
    return settings


def gemini_command(task: Task, model: str) -> list[str]:
    # yolo: every tool call is approved without asking, which a headless run needs; the throwaway container is the sandbox.
    return ["gemini", "-p", task.prompt, "--model", model, "--output-format", "stream-json", "--approval-mode", "yolo"]


def parse_gemini_stream(text: str) -> dict:
    """Metrics from `gemini -p --output-format stream-json`: one JSON event per line (`init`, `message`, `tool_use`,
    `tool_result`, `error`, `result`). A failed attempt is a `tool_result` whose status is not `success`; tokens come
    from the final `result` event's stats. No `result`, or a `result` that is an error, is an agent error."""
    failed, result, errored = 0, {}, False
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "tool_result" and str(event.get("status", "success")).lower() not in ("success", "ok"):
            failed += 1
        elif kind == "error" and str(event.get("severity", "error")).lower() == "error":
            errored = True
        elif kind == "result":
            result = event
    stats = result.get("stats") or {}
    tokens = int(stats.get("total_tokens") or 0) or sum(int(stats.get(k) or 0) for k in ("input_tokens", "output_tokens"))
    turns = int(stats.get("tool_calls") or 0)
    ok = str(result.get("status", "success")).lower() == "success"
    return {"tokens": tokens, "cost_usd": 0.0, "turns": turns, "failed_attempts": failed,
            "agent_error": errored or not result or not ok}


def gemini_credentials() -> str | None:
    """The host's Google sign-in for Gemini CLI, copied into each throwaway container. None when there is none."""
    path = GEMINI_HOME / "oauth_creds.json"
    return path.read_text(encoding="utf-8") if path.is_file() else None


#: The Docker volume a person signs in to once (`docker run -it --rm -v myrmobench-agy:/root/.gemini myrmobench/agy`).
AGY_VOLUME = "myrmobench-agy"
#: Antigravity's tools that reach the web. Its settings do not switch them off, so they stay available in every condition
#: (which keeps a comparison within one run fair) and each run counts how often the agent used them.
AGY_WEB_TOOLS = {"search_web", "read_url_content", "open_browser_url", "read_browser_page", "browser_subagent"}
#: How a failed command shows in agy's output: it reports no exit code, so a command whose output reads like an error
#: counts as a failed attempt. An estimate, unlike the other agents' counts.
AGY_ERROR = re.compile(r"(?im)^\s*(?:\S+:\s*)?(?:error|fatal|traceback|exception)\b|command not found|no such file|"
                       r"cannot find|not found|permission denied|exit (?:status|code) [1-9]|\bfailed\b")


def agy_command(task: Task, model: str) -> list[str]:
    return ["agy", "-p", task.prompt, "--model", model, "--output-format", "stream-json", "--dangerously-skip-permissions"]


def parse_agy_stream(text: str) -> dict:
    """Metrics from `agy -p --output-format stream-json`: `step_update` events (one per step, `DONE` when finished, tool
    steps carry `tool_name` and `tool_info.output`) and a final `result` with the run's `usage`."""
    failed = turns = web = 0
    result: dict = {}
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("event") == "result":
            result = event.get("result") or {}
            continue
        step = event.get("step_update") or {}
        if step.get("step_type") != "tool" or step.get("state") == "ACTIVE":
            continue
        turns += 1
        name = step.get("tool_name") or ""
        web += name in AGY_WEB_TOOLS
        output = str((step.get("tool_info") or {}).get("output") or "")
        if step.get("state") not in ("DONE", None) or (name == "run_command" and AGY_ERROR.search(output)):
            failed += 1
    usage = result.get("usage") or {}
    tokens = int(usage.get("total_tokens") or 0)
    return {"tokens": tokens, "cost_usd": 0.0, "turns": turns, "failed_attempts": failed, "web_tool_calls": web,
            "agent_error": not result or str(result.get("status", "")).upper() != "SUCCESS"}


def claude_command(task: Task, model: str, with_myrmo: bool) -> list[str]:
    allowed = "Bash,Read,Edit,Write,Glob,Grep" + (",mcp__myrmo" if with_myrmo else "")
    command = ["claude", "-p", task.prompt, "--model", model, "--output-format", "stream-json", "--verbose",
               "--allowedTools", allowed, "--max-turns", "60"]
    if with_myrmo:
        command += ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"]
    else:
        command += ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    return command


def run_agent(task: Task, model: str, role: str, condition: str, colony: str, repetition: int, env: list[str],
              agent: str = "claude-code") -> dict:
    """One run: a fresh container from the agent image, the agent works in it, the hidden check decides."""
    with_myrmo = condition != "without"
    # Reach the colony on the host from inside the container.
    extra = ("--add-host", "host.docker.internal:host-gateway")
    if agent == "antigravity":
        extra += ("-v", f"{AGY_VOLUME}:/seed:ro")
    name = start(task, task.agent_tag(agent), extra)
    started = time.time()
    try:
        mcp = mcp_config(colony.replace("localhost", "host.docker.internal"), "auto" if role == "pioneer" else "off",
                         f"bench-{role}-{uuid.uuid4().hex[:8]}")
        exec_env = [x for e in env for x in ("-e", e)]
        if agent == "opencode":
            put(name, "/tmp/opencode.json", json.dumps(opencode_config(with_myrmo, mcp)))
            # The key goes where `opencode auth` would have put it, in the throwaway container only.
            key = dict(e.split("=", 1) for e in env).get("OPENCODE_API_KEY", "")
            put(name, "/root/.local/share/opencode/auth.json", json.dumps({model.split("/")[0]: {"type": "api", "key": key}}))
            exec_env = ["-e", "OPENCODE_CONFIG=/tmp/opencode.json", "-e", f"OPENCODE_PERMISSION={json.dumps(OPENCODE_PERMISSION)}"]
            command, parse = opencode_command(task, model), parse_opencode_events
        elif agent == "gemini":
            key = dict(e.split("=", 1) for e in env).get("GEMINI_API_KEY", "")
            put(name, "/root/.gemini/settings.json", json.dumps(gemini_settings(with_myrmo, mcp, bool(key))))
            if not key:
                # The sign-in goes where `gemini` would have put it, in the throwaway container only.
                put(name, "/root/.gemini/oauth_creds.json", gemini_credentials() or "{}")
            exec_env = ["-e", f"GEMINI_API_KEY={key}"] if key else []
            command, parse = gemini_command(task, model), parse_gemini_stream
        elif agent == "antigravity":
            # The sign-in, from the volume mounted read-only at /seed; then this run's own settings and MCP servers.
            sh("docker", "exec", name, "sh", "-c", "mkdir -p /root/.gemini && cp -r /seed/. /root/.gemini/")
            put(name, "/root/.gemini/antigravity-cli/settings.json", json.dumps({"trustedWorkspaces": ["/"]}))
            put(name, "/root/.gemini/config/mcp_config.json",
                json.dumps({"mcpServers": dict(mcp["mcpServers"]) if with_myrmo else {}}))
            command, parse = agy_command(task, model), parse_agy_stream
        else:
            if with_myrmo:
                put(name, "/tmp/mcp.json", json.dumps(mcp))
            command, parse = claude_command(task, model, with_myrmo), parse_claude_stream
        done = sh("docker", "exec", *exec_env, name, *command, check=False, timeout=task.max_minutes * 60)
        seconds = time.time() - started
        passed, why = check(task, name)
        metrics = parse(done.stdout)
        return {"task": task.id, "model": model, "role": role, "condition": condition, "repetition": repetition,
                "success": passed, "check": why, "seconds": round(seconds, 1), **metrics}
    except subprocess.TimeoutExpired:
        return {"task": task.id, "model": model, "role": role, "condition": condition, "repetition": repetition,
                "success": False, "check": "timeout", "seconds": task.max_minutes * 60, "tokens": 0, "cost_usd": 0.0,
                "turns": 0, "failed_attempts": 0, "agent_error": True}
    finally:
        stop(name)


def choose_models(args: argparse.Namespace) -> dict:
    """The pioneer and the followers: Claude models by default, or whatever `opencode models` lists for OpenCode."""
    if args.agent == "opencode":
        if not args.pioneer or not args.followers:
            raise SystemExit("with --agent opencode, give --pioneer and --followers as <provider>/<model>, "
                             "for example opencode-go/<id> (`opencode models` lists them)")
        bad = [m for m in [args.pioneer, *args.followers] if "/" not in m]
        if bad:
            raise SystemExit(f"{bad}: an OpenCode model is <provider>/<model>")
        return {"pioneer": args.pioneer, "followers": args.followers}
    if args.agent in ("gemini", "antigravity"):
        if not args.pioneer or not args.followers:
            raise SystemExit(f"with --agent {args.agent}, give --pioneer and --followers as model ids "
                             "(`agy models` or `gemini` shows the ones your plan has)")
        return {"pioneer": args.pioneer, "followers": args.followers}
    models = {"pioneer": args.pioneer or "claude-opus-5-5", "followers": args.followers or ["claude-sonnet-5-5"]}
    bad = [m for m in [models["pioneer"], *models["followers"]] if m not in PRICES]
    if bad:
        raise SystemExit(f"{bad}: not a model with a known price; known: {sorted(PRICES)}")
    return models


def cmd_run(args: argparse.Namespace) -> int:
    tasks = load_tasks(args.tasks)
    models = choose_models(args)
    conditions = tuple(args.conditions)
    p = plan(len(tasks), models["followers"], models["pioneer"], args.repetitions, conditions)
    if not args.execute or args.approved_usd is None:
        print(json.dumps(p, indent=2))
        print("\nNothing was run. This spends money: add --execute and --approved-usd <the most you accept to spend>.")
        return 2
    if args.approved_usd < p["estimated_usd_ceiling"]:
        print(f"The plan's ceiling is ${p['estimated_usd_ceiling']} and you approved ${args.approved_usd}. Raise it or run less.")
        return 2
    import os
    keys = {"opencode": ("OPENCODE_API_KEY",), "gemini": ("GEMINI_API_KEY",)}.get(
        args.agent, ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"))
    env = [f"{k}={os.environ[k]}" for k in keys if os.environ.get(k)]
    if args.agent == "antigravity":
        signed_in = sh("docker", "run", "--rm", "-v", f"{AGY_VOLUME}:/g:ro", "debian:bookworm-slim", "test", "-s",
                       "/g/antigravity-cli/antigravity-oauth-token", check=False).returncode == 0
        if not signed_in:
            print(f"Sign in once: docker run -it --rm -v {AGY_VOLUME}:/root/.gemini myrmobench/agy")
            return 2
    elif not env and not (args.agent == "gemini" and gemini_credentials()):
        print("Set " + " or ".join(keys) + "." + (" Or sign in once with `gemini` (Sign in with Google)." if args.agent == "gemini" else ""))
        return 2
    run_id = "myrmobench-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    out = RESULTS / run_id
    out.mkdir(parents=True, exist_ok=True)
    seeded = seed(args.seed_from, args.colony) if args.seed_from else None
    (out / "environment.json").write_text(json.dumps({"plan": p, "colony": args.colony, "agent": args.agent,
                                                      "pioneer": models["pioneer"], "followers": models["followers"],
                                                      "colony_at_start": {"trails": colony_trails(args.colony), "seeded": seeded},
                                                      "claude_code": args.claude_code_version, "opencode": args.opencode_version,
                                                      "gemini": args.gemini_version}, indent=2))
    by_id = {t.id: t for t in tasks}
    if args.agent == "antigravity":
        sh("docker", "build", "-t", "myrmobench/agy", str(HERE / "agy"))
    for task in tasks:
        build(task)
        if args.agent == "antigravity":
            sh("docker", "build", "-t", task.agent_tag(args.agent), "-f", str(HERE / "agy" / "agent.Dockerfile"),
               "--build-arg", f"BASE={task.image_tag}", str(HERE / "agy"))
            continue
        sh("docker", "build", "-t", task.agent_tag(args.agent), "-f", str(HERE / "agent.Dockerfile"), "--build-arg", f"BASE={task.image_tag}",
           "--build-arg", f"AGENT={args.agent}", "--build-arg", f"CLAUDE_CODE_VERSION={args.claude_code_version}",
           "--build-arg", f"OPENCODE_VERSION={args.opencode_version}", "--build-arg", f"GEMINI_VERSION={args.gemini_version}",
           str(HERE))
    spent, runs = 0.0, []
    for step in schedule([t.id for t in tasks], models["pioneer"], models["followers"], args.repetitions, conditions):
        if spent >= args.approved_usd:
            print(f"Stopped: ${spent:.2f} spent of ${args.approved_usd} approved.")
            break
        task, model, role = by_id[step["task"]], step["model"], step["role"]
        before = colony_trails(args.colony) if role == "pioneer" else 0
        row = run_agent(task, model, role, step["condition"], args.colony, step["repetition"], env, args.agent)
        if role == "pioneer":
            # A pioneer that found a trail, or whose fix merged into one, leaves no new trail: its task's `with` runs
            # then measure the colony as it was, and the result says so.
            wait_for_queue(args.colony)
            row["published"] = colony_trails(args.colony) > before
        # A subscription agent may report no cost: the brake then counts the tokens at the assumed price.
        spent += max(row["cost_usd"], row["tokens"] * price_of(model)[0] / 1e6)
        runs.append(row)
        with (out / "runs.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        print(f"{task.id:18} {model:18} {role:8} {step['condition']:8} {'PASS' if row['success'] else 'FAIL'} "
              f"{row['tokens']:>9} tokens ${row['cost_usd']:.3f}" + ("" if role != "pioneer" else f" published={row['published']}"))
    (out / "summary.json").write_text(json.dumps(summarize(runs), indent=2))
    print(f"\n${spent:.2f} spent. Results in {out.relative_to(ROOT)}; publish with publish_results.py.")
    return 0


# --- cli --------------------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "plan", "dry-run", "run", "seed"):
        s = sub.add_parser(name)
        if name == "seed":
            s.add_argument("--from", dest="source", default="https://myrmo.dev", help="the colony whose public trails are copied (only read)")
            s.add_argument("--colony", default="http://localhost:8080", help="the empty local colony to fill")
            continue
        s.add_argument("--tasks", nargs="*", help="only these task ids")
        if name in ("plan", "run"):
            s.add_argument("--agent", choices=AGENTS, default="claude-code", help="the agent CLI that does the work")
            s.add_argument("--pioneer", help="default claude-opus-5-5; with --agent opencode, <provider>/<model>")
            s.add_argument("--followers", nargs="+", help="default claude-sonnet-5-5; with --agent opencode, <provider>/<model> each")
            s.add_argument("--repetitions", type=int, default=5)
            s.add_argument("--conditions", nargs="+", choices=CONDITIONS, default=list(CONDITIONS),
                           help="follower conditions; `--conditions without` alone measures how hard the tasks are")
        if name == "run":
            s.add_argument("--execute", action="store_true", help="really run the agents (spends money)")
            s.add_argument("--approved-usd", type=float, help="the most the person who pays accepts to spend")
            s.add_argument("--colony", default="http://localhost:8080", help="a local colony for the run, empty or seeded")
            s.add_argument("--seed-from", help="copy this colony's public trails into the local one first (for example https://myrmo.dev)")
            s.add_argument("--claude-code-version", default=CLAUDE_CODE_VERSION)
            s.add_argument("--opencode-version", default=OPENCODE_VERSION)
            s.add_argument("--gemini-version", default=GEMINI_VERSION)
    args = parser.parse_args(argv)
    if args.command == "list":
        for t in load_tasks(args.tasks):
            print(f"{t.id:18} {t.title}")
        return 0
    if args.command == "plan":
        models = choose_models(args)
        print(json.dumps(plan(len(load_tasks(args.tasks)), models["followers"], models["pioneer"], args.repetitions,
                              tuple(args.conditions)), indent=2))
        return 0
    if args.command == "seed":
        print(json.dumps(seed(args.source, args.colony), indent=2))
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
