"""The client names itself: a random pseudonym created on first use and kept in the settings file."""

import asyncio
import json

import httpx

from conftest import FakeColony
from myrmo import AsyncColony, Colony, agent_identity, read_config

ERROR = "ModuleNotFoundError: No module named 'x'"


def make(fake, **kwargs):
    return Colony(url="http://colony.test", transport=httpx.MockTransport(fake), cache_ttl=0, **kwargs)


def test_the_first_run_creates_a_random_id_and_the_next_run_is_the_same_agent(tmp_path):
    first, source = agent_identity()
    assert source == "generated" and len(first) == 32
    assert json.loads((tmp_path / "config.json").read_text())["agent_id"] == first
    assert agent_identity() == (first, "file")


def test_two_machines_get_different_ids(tmp_path, monkeypatch):
    a, _ = agent_identity()
    monkeypatch.setenv("MYRMO_CONFIG", str(tmp_path / "other.json"))
    assert agent_identity()[0] != a


def test_an_id_chosen_by_the_user_wins_and_none_can_be_requested(tmp_path, monkeypatch):
    monkeypatch.setenv("MYRMO_AGENT_ID", "chosen-by-the-user")
    assert agent_identity() == ("chosen-by-the-user", "env")
    assert agent_identity("from-the-argument") == ("from-the-argument", "option")
    assert agent_identity(False) == (None, "none")
    monkeypatch.delenv("MYRMO_AGENT_ID")
    monkeypatch.setenv("MYRMO_ANONYMOUS", "1")
    assert agent_identity() == (None, "none")
    assert not (tmp_path / "config.json").exists(), "an anonymous client writes nothing"


def test_a_damaged_id_is_replaced_and_the_users_other_choices_survive(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"publish": "ask", "agent_id": "short"}))
    new, _ = agent_identity()
    assert new != "short"
    assert read_config() == {"publish": "ask", "agent_id": new}


def test_a_settings_file_that_cannot_be_written_still_gives_this_process_an_id(tmp_path, monkeypatch):
    blocker = tmp_path / "a-file"
    blocker.write_text("not a directory")
    monkeypatch.setenv("MYRMO_CONFIG", str(blocker / "config.json"))
    identity, source = agent_identity()
    assert identity and source == "generated"


def test_the_id_and_the_model_go_out_as_headers_on_every_request(monkeypatch):
    monkeypatch.setenv("MYRMO_AGENT_MODEL", "claude-opus-5-5")
    fake = FakeColony()
    colony = make(fake)
    colony.search(ERROR, runtime="python")
    agent = read_config()["agent_id"]
    assert fake.requests
    for _, _, _, headers in fake.requests:
        assert headers["x-myrmo-agent"] == agent
        assert headers["x-myrmo-model"] == "claude-opus-5-5"
    colony.search("ModuleNotFoundError: No module named 'y'", runtime="python", model="gpt-5")
    assert fake.requests[-1][3]["x-myrmo-model"] == "gpt-5", "a search can say which model asks"


def test_a_header_the_caller_passes_wins_and_agent_id_false_sends_none():
    fake = FakeColony()
    make(fake, agent_id=False, headers={"x-myrmo-agent": "the-callers-own-id"}).search(ERROR, runtime="python")
    assert fake.requests[-1][3]["x-myrmo-agent"] == "the-callers-own-id"
    fake = FakeColony()
    make(fake, agent_id=False).search(ERROR, runtime="python")
    assert "x-myrmo-agent" not in fake.requests[-1][3]


def test_the_model_unknown_is_not_worth_sending(monkeypatch):
    monkeypatch.setenv("MYRMO_AGENT_MODEL", "unknown")
    fake = FakeColony()
    make(fake).search(ERROR, runtime="python")
    assert "x-myrmo-model" not in fake.requests[-1][3]


def test_the_async_client_sends_the_same_headers(monkeypatch):
    monkeypatch.setenv("MYRMO_AGENT_MODEL", "claude-opus-5-5")
    fake = FakeColony()

    async def run():
        async with AsyncColony(url="http://colony.test", transport=httpx.MockTransport(fake), cache_ttl=0) as colony:
            await colony.search(ERROR, runtime="python", model="gpt-5")

    asyncio.run(run())
    assert fake.requests[-1][3]["x-myrmo-agent"] == read_config()["agent_id"]
    assert fake.requests[-1][3]["x-myrmo-model"] == "gpt-5"
