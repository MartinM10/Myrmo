"""Tests that need no Docker and spend nothing."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import run  # noqa: E402


def test_every_task_is_complete_and_unique():
    tasks = run.load_tasks()
    assert len(tasks) == 4
    assert len({t.id for t in tasks}) == 4 and len({t.image_tag for t in tasks}) == 4
    for t in tasks:
        assert t.prompt and t.symptom_match and t.max_minutes > 0
        check = (t.path / "check.sh").read_text()
        assert "PASS" in check and "FAIL" in check
        # An agent must not be able to read its answer from the task image.
        assert "check.sh" not in (t.path / "Dockerfile").read_text()
        assert "solution.sh" not in (t.path / "Dockerfile").read_text()


def test_the_plan_counts_runs_and_gives_a_ceiling():
    p = run.plan(tasks=4, followers=["claude-sonnet-5-5"], pioneer="claude-opus-5-5", repetitions=5)
    assert p["runs"] == 4 + 4 * 5 * 2
    assert p["by_role"]["followers"] == {"claude-sonnet-5-5": 40}
    assert 0 < p["estimated_usd_ceiling"] < 1000
    two = run.plan(4, ["claude-sonnet-5-5", "claude-opus-5-5"], "claude-opus-5-5", 5)
    assert two["estimated_usd_ceiling"] > p["estimated_usd_ceiling"]


def test_run_refuses_to_spend_without_an_approved_amount(capsys):
    assert run.main(["run", "--tasks", "uv-path"]) == 2
    assert "Nothing was run" in capsys.readouterr().out
    assert run.main(["run", "--execute", "--tasks", "uv-path"]) == 2
    assert run.main(["run", "--execute", "--approved-usd", "0.01", "--tasks", "uv-path"]) == 2


def test_a_claude_stream_gives_tokens_cost_and_failed_attempts():
    lines = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True, "content": "uv: not found"}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        {"type": "result", "is_error": False, "num_turns": 4, "total_cost_usd": 0.12,
         "usage": {"input_tokens": 100, "output_tokens": 50, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 40}},
    ]
    m = run.parse_claude_stream("\n".join(json.dumps(x) for x in lines) + "\nnot json")
    assert m == {"tokens": 200, "cost_usd": 0.12, "turns": 4, "failed_attempts": 1, "agent_error": False}
    assert run.parse_claude_stream("")["agent_error"] is True


def test_an_opencode_stream_gives_tokens_cost_and_failed_attempts():
    lines = [
        {"type": "step_start", "part": {"type": "step-start"}},
        {"type": "tool_use", "part": {"type": "tool", "tool": "bash", "state": {"status": "error", "error": "uv: not found"}}},
        {"type": "tool_use", "part": {"type": "tool", "tool": "bash", "state": {"status": "completed", "output": "ok"}}},
        {"type": "text", "part": {"type": "text", "text": "done"}},
        {"type": "step_finish", "part": {"cost": 0.01, "tokens": {"input": 100, "output": 50, "reasoning": 5, "cache": {"read": 40, "write": 10}}}},
        {"type": "step_finish", "part": {"cost": 0.02, "tokens": {"input": 10, "output": 5, "cache": {"read": 0, "write": 0}}}},
    ]
    m = run.parse_opencode_events("\n".join(json.dumps(x) for x in lines) + "\nnot json\n[1]")
    assert m == {"tokens": 220, "cost_usd": pytest.approx(0.03), "turns": 2, "failed_attempts": 1, "agent_error": False}
    assert run.parse_opencode_events("")["agent_error"] is True
    assert run.parse_opencode_events(json.dumps({"type": "error", "error": {"name": "ApiError"}}))["agent_error"] is True
    # What opencode 1.18 really prints, with exit code 0, when the model cannot be reached.
    real = '{"type":"error","timestamp":1791536285524,"sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}'
    assert run.parse_opencode_events(real)["agent_error"] is True
    one = [{"type": "step_finish", "part": {"tokens": {"input": 1}}}, {"type": "error", "error": {}}]
    assert run.parse_opencode_events("\n".join(json.dumps(x) for x in one))["agent_error"] is True


def test_opencode_gets_myrmo_only_in_the_with_condition_and_no_web():
    task = run.load_tasks(["uv-path"])[0]
    mcp = run.mcp_config("http://colony", "off", "bench-1")
    without = run.opencode_config(False, mcp)
    assert "mcp" not in without and without["autoupdate"] is False and without["share"] == "disabled"
    server = run.opencode_config(True, mcp)["mcp"]["myrmo"]
    assert server["type"] == "local" and server["command"][0] == "npx" and server["command"][2].startswith("myrmo-mcp@")
    assert server["environment"]["MYRMO_PUBLISH"] == "off"
    assert run.OPENCODE_PERMISSION["webfetch"] == "deny" and run.OPENCODE_PERMISSION["websearch"] == "deny"
    command = run.opencode_command(task, "opencode-go/some-model")
    assert command[:2] == ["opencode", "run"] and command[command.index("--format") + 1] == "json"
    assert command[command.index("--model") + 1] == "opencode-go/some-model"


def test_models_are_chosen_per_agent_and_unknown_ones_are_priced_high():
    def args(agent, pioneer=None, followers=None):
        return run.argparse.Namespace(agent=agent, pioneer=pioneer, followers=followers)

    assert run.choose_models(args("claude-code")) == {"pioneer": "claude-opus-5-5", "followers": ["claude-sonnet-5-5"]}
    with pytest.raises(SystemExit):
        run.choose_models(args("claude-code", "gpt-x"))
    with pytest.raises(SystemExit):
        run.choose_models(args("opencode"))
    with pytest.raises(SystemExit):
        run.choose_models(args("opencode", "opencode-go/a", ["b"]))
    models = run.choose_models(args("opencode", "opencode-go/a", ["opencode-go/b"]))
    cheap = run.plan(4, models["followers"], models["pioneer"], 5)
    assert cheap["runs"] == 44 and cheap["estimated_usd_ceiling"] > 0
    assert run.price_of("opencode-go/a") == run.ASSUMED_PRICE
    task = run.load_tasks(["uv-path"])[0]
    assert task.agent_tag() != task.agent_tag("opencode") and task.agent_tag().endswith("-agent")


def test_the_summary_compares_with_and_without_myrmo():
    def r(condition, success, tokens, failed, seconds):
        return {"role": "follower", "condition": condition, "success": success, "tokens": tokens,
                "failed_attempts": failed, "seconds": seconds, "cost_usd": 0.1}
    rows = [r("without", True, 1000, 3, 60), r("without", False, 3000, 5, 120), r("with", True, 400, 0, 30), r("with", True, 600, 1, 40),
            {"role": "pioneer", "condition": "with", "success": True, "tokens": 9, "failed_attempts": 9, "seconds": 9, "cost_usd": 1}]
    s = run.summarize(rows)
    assert s["without"]["success_rate"] == 0.5 and s["with"]["success_rate"] == 1.0
    assert s["without"]["median_tokens"] == 2000 and s["with"]["median_tokens"] == 500
    assert s["with"]["runs"] == 2, "the pioneer is not a follower"


def test_the_with_condition_connects_myrmo_and_the_without_does_not():
    task = run.load_tasks(["uv-path"])[0]
    assert "--mcp-config" in run.claude_command(task, "claude-sonnet-5-5", True)
    assert "mcp__myrmo" in " ".join(run.claude_command(task, "claude-sonnet-5-5", True))
    assert "mcp__myrmo" not in " ".join(run.claude_command(task, "claude-sonnet-5-5", False))
    cfg = run.mcp_config("http://colony", "off", "bench-1")
    assert cfg["mcpServers"]["myrmo"]["args"][1].startswith("myrmo-mcp@")
    assert cfg["mcpServers"]["myrmo"]["env"]["MYRMO_PUBLISH"] == "off"


def test_a_run_without_both_conditions_is_not_published(tmp_path):
    import publish_results

    (tmp_path / "environment.json").write_text(json.dumps({"pioneer": "p", "followers": ["f"], "plan": {"tasks": 1, "by_role": {"followers": {"f": 2}}}}))
    row = {"task": "uv-path", "role": "follower", "condition": "without", "success": True, "tokens": 1, "failed_attempts": 0, "seconds": 1, "cost_usd": 0}
    (tmp_path / "runs.jsonl").write_text(json.dumps(row) + "\n")
    with pytest.raises(SystemExit):
        publish_results.value_section(tmp_path)
    (tmp_path / "runs.jsonl").write_text(json.dumps(row) + "\n" + json.dumps({**row, "condition": "with"}) + "\n")
    run_dir = tmp_path.parent / "myrmobench-20261101-1200"
    run_dir.mkdir(exist_ok=True)
    for name in ("environment.json", "runs.jsonl"):
        (run_dir / name).write_text((tmp_path / name).read_text())
    section = publish_results.value_section(run_dir)
    assert section["date"] == "2026-11-01" and section["repetitions"] == 1 and set(section["tasks"]) == {"uv-path"}
    assert section["agent"] == "claude-code", "a run from before the agent was recorded was Claude Code"
