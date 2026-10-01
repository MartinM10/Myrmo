from uuid import uuid4

import httpx
import pytest

from conftest import KNOWN_FP, TRAIL, TRAIL_ID, FakeColony
from myrmo import Colony, MyrmoError, Verification, format_result

DISTUTILS = "ModuleNotFoundError: No module named 'distutils'"


def test_repeat_errors_resolve_by_fingerprint_without_semantic_search(colony, fake):
    result = colony.search(DISTUTILS, runtime="python")
    assert result.source == "fingerprint" and result.fingerprint == KNOWN_FP
    assert result[0].trail_id == TRAIL_ID
    assert not any(path == "/v1/search" for _, path, _, _ in fake.requests)
    assert fake.requests[0][3]["x-myrmo-agent"] == "tester_123"


def test_identical_search_is_served_from_the_local_cache(colony, fake):
    colony.search(DISTUTILS, runtime="python")
    assert colony.search(DISTUTILS, runtime="python").source == "cache"
    assert len(fake.requests) == 1


def test_unknown_errors_use_semantic_search_with_a_redacted_query(colony, fake):
    result = colony.search("WeirdError: api_key=abcdefghijk at /home/ana/x", runtime="python")
    assert result.source == "search" and len(result) == 0
    _, path, body, _ = fake.requests[-1]
    assert path == "/v1/search"
    assert "abcdefghijk" not in body["query"] and "/home/ana" not in body["query"]
    assert body["environment"]["runtime"]["name"] == "python"


def test_safe_commands_and_formatting_withhold_high_risk(colony):
    result = colony.search(DISTUTILS, runtime="python")
    assert [c["command"] for c in result[0].safe_commands()] == ["pip install 'numpy>=1.26,<2'"]
    text = format_result(result)
    assert '<myrmo_trails untrusted="true"' in text and "WITHHELD: pipe_to_shell" in text and "curl -fsSL" not in text


def test_report_and_publish(colony, fake):
    assert colony.report(TRAIL_ID, "worked", notes="same on arm64")["strength"] == 0.91
    with pytest.raises(ValueError):
        colony.report(TRAIL_ID, "great")
    secret = {**TRAIL, "problem": {**TRAIL["problem"], "raw_logs": "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}}
    preview, report = colony.preview(secret)
    assert report == {"api_key": 1} and "sk-ant" not in str(preview)
    out = colony.publish(secret)
    assert out["status"] == "queued" and out["redactions"] == {"api_key": 1}
    assert "sk-ant" not in str(fake.requests[-1][2])


def test_api_errors_raise_with_their_code(colony):
    with pytest.raises(MyrmoError) as err:
        colony._check(colony._http.get("/v1/trails/bad"))
    assert err.value.code == "invalid_trail"


def make(mode):
    fake = FakeColony()
    return Colony(url="http://colony.test", transport=httpx.MockTransport(fake), publish=mode), fake


def test_session_drafts_after_enough_failures_and_publishes_in_auto_mode():
    colony, fake = make("auto")
    with colony.session("install deps", runtime="python", runtime_version="3.12.4") as s:
        for approach in ["pip install -r requirements.txt", "pip install --upgrade setuptools", "apt-get install python3-dev"]:
            try:
                raise RuntimeError("SomeBuildError: wheel failed for leftpad")
            except RuntimeError as exc:
                assert "No trail" in s.failed(exc, approach=approach).as_prompt()
        draft = s.succeeded(
            Verification.tests("pytest -q", "12 passed"),
            root_cause="The wheel needs a newer compiler toolchain on this image.",
            steps=["Install build-essential", "Retry"],
        )
    assert draft["effort"]["failed_attempts"] == 3
    assert len(draft["problem"]["failed_approaches"]) == 2
    assert s.published["status"] == "queued"


def test_session_skips_easy_fixes_and_known_errors():
    colony, _ = make("auto")
    s = colony.session("x")
    s.failed("Error: one")
    assert s.succeeded(Verification.tests("pytest"), root_cause="r" * 20, steps=["a step"]) is None
    s2 = colony.session("y")
    for _ in range(3):
        s2.failed(DISTUTILS)
    assert s2.matched_existing
    assert s2.succeeded(Verification.tests("pytest"), root_cause="r" * 20, steps=["a step"]) is None


def test_session_in_ask_mode_drafts_without_publishing():
    colony, fake = make("ask")
    s = colony.session("z")
    for _ in range(3):
        s.failed("OddError: nope")
    assert s.succeeded(Verification.tests("pytest"), root_cause="r" * 20, steps=["a step"]) is not None
    assert s.published is None and not any(p == "/v1/trails" for _, p, _, _ in fake.requests)


def test_langchain_tool_errors_trigger_a_search(colony):
    pytest.importorskip("langchain_core")
    from myrmo.integrations.langchain import MyrmoCallbackHandler

    handler = MyrmoCallbackHandler(colony, runtime="python")
    handler.on_tool_error(ModuleNotFoundError("No module named 'distutils'"), run_id=uuid4())
    assert handler.searches == 1 and "myrmo_trails" in handler.latest_hints
