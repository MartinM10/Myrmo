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
    assert p["runs"] == 4 + 4 * 5 * 3, "three conditions: without, unseen, with"
    assert p["by_role"]["followers"] == {"claude-sonnet-5-5": 60}
    assert p["conditions"] == ["without", "unseen", "with"]
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
    assert cheap["runs"] == 64 and cheap["estimated_usd_ceiling"] > 0
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


def test_measuring_how_hard_the_tasks_are_needs_no_pioneer():
    p = run.plan(4, ["claude-sonnet-5-5"], "claude-opus-5-5", 2, ("without",))
    assert p["runs"] == 8 and p["by_role"]["pioneer"] == {}
    assert "claude-opus-5-5" not in p["per_run_usd"]
    assert all(s["condition"] == "without" for s in run.schedule(["a", "b"], "p", ["f"], 2, ("without",)))


def test_no_pioneer_runs_until_every_run_that_must_not_see_its_trail_is_done():
    steps = run.schedule(["a", "b"], "pioneer-model", ["f1", "f2"], 2)
    roles = [(s["role"], s["condition"]) for s in steps]
    first_pioneer = roles.index(("pioneer", "with"))
    assert all(c in ("without", "unseen") for _, c in roles[:first_pioneer])
    assert all(c == "with" for _, c in roles[first_pioneer:])
    assert sum(r == "pioneer" for r, _ in roles) == 2
    count = lambda c: sum(1 for s in steps if s["role"] == "follower" and s["condition"] == c)
    assert count("without") == count("unseen") == count("with") == 2 * 2 * 2
    # The two conditions before the pioneers alternate, so neither gets all the slow hours of an API.
    assert [s["condition"] for s in steps[:4]] == ["without", "unseen", "without", "unseen"]


def test_only_the_without_condition_runs_without_myrmo():
    task = run.load_tasks(["uv-path"])[0]
    for condition, connected in (("without", False), ("unseen", True), ("with", True)):
        assert ("mcp__myrmo" in " ".join(run.claude_command(task, "m", condition != "without"))) is connected


def test_the_public_trails_are_read_page_by_page(monkeypatch):
    pages = {
        None: {"items": [{"trail": {"id": 1}}, {"trail": {"id": 2}}, {"no": "trail"}], "next_cursor": "2"},
        "2": {"items": [{"trail": {"id": 3}}], "next_cursor": None},
    }
    seen = []

    def fake(url, body=None, timeout=60):
        assert body is None, "reading the public colony never writes to it"
        cursor = run.urllib.parse.parse_qs(run.urllib.parse.urlparse(url).query).get("cursor", [None])[0]
        seen.append(cursor)
        return pages[cursor]

    monkeypatch.setattr(run, "http_json", fake)
    assert [t["id"] for t in run.public_trails("https://colony.example/")] == [1, 2, 3]
    assert seen == [None, "2"]


def test_a_colony_that_already_holds_trails_is_not_seeded(monkeypatch):
    monkeypatch.setattr(run, "colony_trails", lambda colony: 7)
    with pytest.raises(SystemExit):
        run.seed("https://colony.example", "http://localhost:8080")


def test_the_unseen_condition_is_summarised_and_published(tmp_path):
    import publish_results

    def r(condition, tokens):
        return {"task": "uv-path", "role": "follower", "condition": condition, "success": True, "tokens": tokens,
                "failed_attempts": 0, "seconds": 1, "cost_usd": 0}
    rows = [r("without", 1000), r("unseen", 1100), r("with", 400),
            {"task": "uv-path", "role": "pioneer", "condition": "with", "success": True, "tokens": 9, "failed_attempts": 1,
             "seconds": 9, "cost_usd": 1, "published": True}]
    assert run.summarize(rows)["unseen"]["median_tokens"] == 1100
    run_dir = tmp_path / "myrmobench-20261101-1200"
    run_dir.mkdir()
    env = {"pioneer": "p", "followers": ["f"], "colony_at_start": {"trails": 119},
           "plan": {"tasks": 1, "conditions": ["without", "unseen", "with"], "by_role": {"followers": {"f": 3}}}}
    (run_dir / "environment.json").write_text(json.dumps(env))
    (run_dir / "runs.jsonl").write_text("".join(json.dumps(x) + "\n" for x in rows))
    section = publish_results.value_section(run_dir)
    assert section["unseen"]["median_tokens"] == 1100 and section["with"]["median_tokens"] == 400
    assert section["repetitions"] == 1 and section["colony_trails_at_start"] == 119 and section["pioneers_published"] == 1


def test_gemini_gets_myrmo_only_when_the_run_has_it_and_no_web():
    mcp = run.mcp_config("http://colony", "off", "bench-1")
    without = run.gemini_settings(False, mcp, api_key=False)
    assert without["mcpServers"] == {} and without["security"]["auth"]["selectedType"] == "oauth-personal"
    assert set(run.GEMINI_EXCLUDED_TOOLS) <= set(without["tools"]["exclude"])
    connected = run.gemini_settings(True, mcp, api_key=True)
    assert connected["mcpServers"]["myrmo"]["env"]["MYRMO_PUBLISH"] == "off"
    assert connected["security"]["auth"]["selectedType"] == "gemini-api-key"
    command = run.gemini_command(run.load_tasks(["uv-path"])[0], "gemini-flash-x")
    assert command[:2] == ["gemini", "-p"] and command[command.index("--output-format") + 1] == "stream-json"
    assert command[command.index("--approval-mode") + 1] == "yolo" and command[command.index("--model") + 1] == "gemini-flash-x"


def test_a_gemini_stream_gives_tokens_and_failed_attempts():
    lines = [
        {"type": "init", "model": "gemini-flash-x"},
        {"type": "tool_use", "tool_name": "run_shell_command"},
        {"type": "tool_result", "status": "error", "output": "uv: not found"},
        {"type": "tool_result", "status": "success", "output": "ok"},
        {"type": "result", "status": "success", "stats": {"total_tokens": 1234, "input_tokens": 1000, "output_tokens": 234, "tool_calls": 2}},
    ]
    m = run.parse_gemini_stream("\n".join(json.dumps(x) for x in lines) + "\nnot json\n[1]")
    assert m == {"tokens": 1234, "cost_usd": 0.0, "turns": 2, "failed_attempts": 1, "agent_error": False}
    assert run.parse_gemini_stream("")["agent_error"] is True
    failed = {"type": "result", "status": "error", "stats": {"input_tokens": 10, "output_tokens": 5}}
    assert run.parse_gemini_stream(json.dumps(failed)) == {"tokens": 15, "cost_usd": 0.0, "turns": 0, "failed_attempts": 0, "agent_error": True}


def test_gemini_models_are_named_by_the_person_who_runs_it():
    args = lambda pioneer=None, followers=None: run.argparse.Namespace(agent="gemini", pioneer=pioneer, followers=followers)
    with pytest.raises(SystemExit):
        run.choose_models(args())
    assert run.choose_models(args("gemini-pro-x", ["gemini-flash-x"])) == {"pioneer": "gemini-pro-x", "followers": ["gemini-flash-x"]}
    assert run.price_of("gemini-flash-x") == run.ASSUMED_PRICE


def test_an_antigravity_stream_gives_tokens_turns_and_estimated_failures():
    # The shape agy 1.3.3 really prints (captured), with the tool output shortened.
    lines = [
        {"event": "init", "init": {"model": "gemini-3.8-flash-low", "tools": ["run_command", "search_web"]}},
        {"event": "step_update", "step_update": {"step_index": 1, "state": "DONE", "step_type": "agent_response", "usage": {"total_tokens": 11843}}},
        {"event": "step_update", "step_update": {"step_index": 2, "state": "ACTIVE", "step_type": "tool", "tool_name": "run_command"}},
        {"event": "step_update", "step_update": {"step_index": 2, "state": "DONE", "step_type": "tool", "tool_name": "run_command",
                                                 "tool_info": {"output": "ls: cannot access '/x': No such file or directory\r\n"}}},
        {"event": "step_update", "step_update": {"step_index": 3, "state": "DONE", "step_type": "tool", "tool_name": "run_command",
                                                 "tool_info": {"output": "DB OK 42\r\n"}}},
        {"event": "step_update", "step_update": {"step_index": 4, "state": "DONE", "step_type": "tool", "tool_name": "search_web"}},
        {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "usage": {"total_tokens": 23781}}},
    ]
    m = run.parse_agy_stream("\n".join(json.dumps(x) for x in lines) + "\nexit=0")
    assert m == {"tokens": 23781, "cost_usd": 0.0, "turns": 3, "failed_attempts": 1, "web_tool_calls": 1, "agent_error": False}
    assert run.parse_agy_stream("")["agent_error"] is True
    assert run.parse_agy_stream(json.dumps({"event": "result", "result": {"status": "ERROR"}}))["agent_error"] is True
