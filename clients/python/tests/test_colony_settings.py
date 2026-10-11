"""The colony in the settings file (written by `npx myrmo-mcp init --url`): its key, private mode and publish choice
apply only while that colony is the one in use."""

import json
import os

import pytest

from myrmo import Colony, file_colony, publish_choice, read_config

PRIVATE = {"url": "https://myrmo.example.internal/", "api_key": "myk_" + "a" * 64, "private": True, "publish": "auto"}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("MYRMO_URL", "MYRMO_API_KEY"):
        monkeypatch.delenv(key, raising=False)


def save(settings):
    with open(os.environ["MYRMO_CONFIG"], "w", encoding="utf-8") as f:
        json.dump(settings, f)


def test_the_file_chooses_the_colony_and_its_key_goes_with_it():
    save({"colony": PRIVATE})
    colony = Colony()
    assert colony.url == "https://myrmo.example.internal"
    assert colony.headers["authorization"] == "Bearer " + PRIVATE["api_key"]
    assert colony.publish_mode == "auto" and colony.publish_source == "file"


def test_a_key_is_never_sent_to_another_colony(monkeypatch):
    save({"colony": PRIVATE, "publish": "ask"})
    monkeypatch.setenv("MYRMO_URL", "https://myrmo.dev")
    colony = Colony()
    assert colony.url == "https://myrmo.dev"
    assert "authorization" not in colony.headers
    assert colony.publish_mode == "ask", "the private colony's choice never applies to the public one"
    assert file_colony("https://myrmo.dev") is None
    assert file_colony("https://myrmo.example.internal/")["private"] is True


def test_the_environment_still_wins(monkeypatch):
    save({"colony": PRIVATE})
    monkeypatch.setenv("MYRMO_API_KEY", "myk_" + "b" * 64)
    monkeypatch.setenv("MYRMO_PUBLISH", "off")
    colony = Colony()
    assert colony.headers["authorization"].endswith("b" * 64)
    assert publish_choice(None, colony.url) == ("off", "env")


def test_a_damaged_colony_entry_is_ignored():
    save({"colony": {"url": "not a url", "api_key": "myk_x"}})
    assert "colony" not in read_config()
    save({"colony": {"url": "http://localhost:8080", "api_key": "has space in it", "private": "yes"}})
    assert read_config()["colony"] == {"url": "http://localhost:8080"}


def test_all_trails_pages_through_the_feed():
    import httpx

    pages = {None: {"items": [{"trail_id": "a"}, {"trail_id": "b"}], "next_cursor": "50"}, "50": {"items": [{"trail_id": "c"}], "next_cursor": None}}

    def fake(request):
        cursor = request.url.params.get("cursor")
        assert request.url.path == "/v1/feed" and request.url.params["limit"] == "50"
        return httpx.Response(200, json=pages[cursor])

    colony = Colony(url="http://colony.test", transport=httpx.MockTransport(fake), agent_id="tester_123")
    assert [t["trail_id"] for t in colony.all_trails()] == ["a", "b", "c"]


def test_a_trail_says_when_none_of_its_commands_is_flagged_and_does_not_ask_twice():
    from myrmo.format import format_result
    from myrmo.client import Hit, SearchResult
    trail = {"environment": {"os": "linux", "runtime": {"name": "python", "version": "3.12"}}, "problem": {"error_type": "E", "error_message": "x", "summary": "s" * 20},
             "solution": {"root_cause": "r" * 10, "steps": ["a"], "shell_commands_executed": [{"command": "acmectl db migrate", "purpose": "apply"}], "code_patches": [],
                          "verification_method": {"type": "command_exit_zero", "description": "d", "command": "acmectl db migrate", "evidence": "ok"}}}
    def render(flags):
        hit = Hit(trail_id="3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b", match={"via": "fingerprint", "score": 1.0}, strength=0.3, outcomes={"worked": 0, "partially_worked": 0, "failed": 0},
                  risk={"level": "medium" if flags else "low", "flags": flags}, trail=trail)
        return format_result(SearchResult(fingerprint="fp2_0000000000000000", hits=[hit], notice="", source="search"))
    plain = render([])
    assert "flagged none of these commands" in plain
    assert "ask the user first" not in plain, "the verification command is one of the analysed commands"
    flagged = render([{"command_index": 0, "level": "medium", "flag": "f", "detail": "d"}])
    assert "flagged none" not in flagged and "ask the user before running" in flagged
