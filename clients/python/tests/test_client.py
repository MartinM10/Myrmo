import json
from uuid import uuid4

import httpx
import pytest

from conftest import KNOWN_FP, TRAIL, TRAIL_ID, FakeColony
from myrmo import AsyncColony, Colony, MyrmoError, Verification, format_result

from conftest import RESULT as _RESULT

RESULT_ABOUT_OTHER_MODULE = {**_RESULT, "trail": {**_RESULT["trail"], "problem": {**_RESULT["trail"]["problem"], "error_message": "main.go:9:2: no required module provides package github.com/stretchr/testify; to add it"}}}

DISTUTILS = "ModuleNotFoundError: No module named 'distutils'"


def test_repeat_errors_resolve_by_fingerprint_without_semantic_search(colony, fake):
    result = colony.search(DISTUTILS, runtime="python")
    assert result.source == "fingerprint" and result.fingerprint == KNOWN_FP
    assert result[0].trail_id == TRAIL_ID
    assert not any(path == "/v1/search" for _, path, _, _ in fake.requests)
    assert fake.requests[0][3]["x-myrmo-agent"] == "tester_123"


def test_a_repeat_error_is_found_whatever_type_the_trail_declared_and_however_it_is_wrapped(colony, fake):
    # The trail's own message carries another class (and the key is the message alone), yet the exact lookup answers.
    for line in (DISTUTILS, "No module named 'distutils'", "Uncaught ModuleNotFoundError: No module named 'distutils'"):
        assert colony.search(line).source in ("fingerprint", "cache")
    assert not any(path == "/v1/search" for _, path, _, _ in fake.requests)


def test_a_colony_that_predates_fp2_still_answers_through_the_search(colony, fake, monkeypatch):
    original = fake.__call__

    def old_colony(request):
        if request.url.path.startswith("/v1/trails/by-fingerprint/"):
            return httpx.Response(400, json={"error": {"code": "bad_request", "message": "Expected a fingerprint like fp1_0123456789abcdef."}})
        return original(request)

    colony._http._transport = httpx.MockTransport(old_colony)
    result = colony.search(DISTUTILS, runtime="python")
    assert result.source == "search"
    assert any(path == "/v1/search" for _, path, _, _ in fake.requests)


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


def test_session_skips_tasks_without_a_failure_and_known_errors():
    colony, _ = make("auto")
    s = colony.session("x")
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


NEW_TRAIL = "c71e0f4a-2b9d-4e63-a8f5-0d3b7c1e9a26"


def test_a_draft_waits_for_the_user_and_redacts_first(colony, fake):
    secret = {**TRAIL, "problem": {**TRAIL["problem"], "raw_logs": "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}}
    draft = colony.create_draft(secret)
    assert draft["approve_url"].endswith("#" + "a" * 32)
    assert draft["redactions"]["api_key"] == 2  # once locally, once counted by the colony
    sent = next(body for method, path, body, _ in fake.requests if path == "/v1/drafts")
    assert "sk-ant-api03" not in json.dumps(sent), "the secret never leaves the machine"
    assert colony.draft("a" * 32)["state"] == "pending"
    assert colony.draft("b" * 32) is None, "an expired draft is None"
    assert not any(path == "/v1/trails" and method == "POST" for method, path, _, _ in fake.requests), "creating a draft publishes nothing"


def test_wait_for_trail_returns_the_verdict(colony):
    verdict = colony.wait_for_trail(NEW_TRAIL, timeout=5, interval=0)
    assert verdict["status"] == "indexed"


def test_wait_for_trail_gives_up_and_returns_the_last_state(colony, fake):
    fake.verdicts = [{"status": "queued"}]
    assert colony.wait_for_trail(NEW_TRAIL, timeout=0.05, interval=0.01)["status"] == "queued"


def test_a_rejected_trail_comes_with_its_reasons(colony, fake):
    fake.verdicts = [{"status": "rejected", "reasons": ["prompt_injection"]}]
    verdict = colony.wait_for_trail(NEW_TRAIL, timeout=5, interval=0)
    assert verdict["status"] == "rejected" and verdict["reasons"] == ["prompt_injection"]


def test_async_drafts_and_verdicts():
    import asyncio

    async def scenario():
        async with AsyncColony(transport=httpx.MockTransport(FakeColony())) as colony:
            draft = await colony.create_draft(TRAIL)
            assert draft["draft_id"] == "a" * 32
            assert (await colony.draft("a" * 32))["state"] == "pending"
            assert (await colony.wait_for_trail(NEW_TRAIL, timeout=5, interval=0))["status"] == "indexed"

    asyncio.run(scenario())


def test_possible_names_lists_capitalised_runs_and_ignores_sentence_starts(colony):
    trail = {"problem": {"summary": "Connector for Acme Data Systems fails. Install Python first."}, "steps": ["Open the Management API"]}
    assert colony.possible_names(trail) == ["Acme Data Systems", "Management API"]
    assert colony.possible_names({"a": "Install Python and run it", "b": "no names here"}) == []


def test_an_organisation_in_a_configuration_value_is_removed():
    from myrmo import redact_text

    assert redact_text("edc.ui.organization=Acme Corp") == "edc.ui.organization=<redacted:org>"
    assert redact_text("org.eclipse.edc:dcp-core:1.0.0") == "org.eclipse.edc:dcp-core:1.0.0"


def test_an_exact_hit_about_another_package_is_not_an_answer(colony, fake):
    # fp2 erases the module path, so the key of one Go module is the key of every other: the answer has to be checked.
    error = "main.go:4:2: no required module provides package github.com/acme/widgets; to add it"
    other = {**RESULT_ABOUT_OTHER_MODULE}

    def handler(request):
        if request.url.path.startswith("/v1/trails/by-fingerprint/"):
            return httpx.Response(200, json={"fingerprint": "fp2_0123456789abcdef", "results": [other], "notice": "untrusted"})
        return fake(request)

    colony._http._transport = httpx.MockTransport(handler)
    result = colony.search(error, runtime="go")
    assert result.source == "search" and len(result) == 0
    assert any(path == "/v1/search" for _, path, _, _ in fake.requests)

    # The same module is the answer; so is a message that names none.
    same = {**other, "trail": {**other["trail"], "problem": {**other["trail"]["problem"], "error_message": error}}}
    colony._http._transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"fingerprint": "fp2_0123456789abcdef", "results": [same], "notice": "untrusted"}) if r.url.path.startswith("/v1/trails/by-fingerprint/") else fake(r))
    colony._cache.clear()
    assert colony.search(error, runtime="go").source == "fingerprint"
