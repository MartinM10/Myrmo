import json

import httpx
import pytest

from conftest import FakeColony
from myrmo import Colony, Verification, publish_choice, read_config, write_config
from myrmo.__main__ import main as cli

KNOWN = "ModuleNotFoundError: No module named 'distutils'"
TRAIL_ID = "3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b"


def colony(mode="ask"):
    fake = FakeColony()
    return Colony(url="http://colony.test", transport=httpx.MockTransport(fake), publish=mode), fake


def done(s):
    return s.succeeded(Verification.tests("pytest -q", "ok"), root_cause="r" * 20, steps=["a step"])


def test_one_failed_attempt_and_a_verified_fix_are_enough():
    c, _ = colony()
    s = c.session("task")
    s.failed("OddError: nope")
    draft = done(s)
    assert draft and draft["effort"]["failed_attempts"] == 1


def test_no_failed_attempt_means_nothing_to_publish():
    c, _ = colony()
    assert done(c.session("task")) is None


def test_a_trail_that_worked_means_nothing_new_to_publish():
    c, fake = colony()
    s = c.session("task")
    s.failed(KNOWN)
    s.tried(TRAIL_ID, "worked")
    assert done(s) is None
    assert any(p.endswith("/outcomes") for _, p, _, _ in fake.requests)


def test_a_trail_that_failed_makes_the_agents_fix_a_published_alternative():
    c, fake = colony("auto")
    s = c.session("task")
    s.failed(KNOWN, approach="first attempt")
    s.tried(TRAIL_ID, "failed", "needs a different flag on arm64")
    draft = done(s)
    assert draft is not None and s.published is not None
    dead = json.dumps(draft["problem"]["failed_approaches"])
    assert TRAIL_ID in dead and "different flag on arm64" in dead
    assert any(p == "/v1/trails" for _, p, _, _ in fake.requests)


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setenv("MYRMO_CONFIG", str(path))
    monkeypatch.delenv("MYRMO_PUBLISH", raising=False)
    return path


def test_publish_mode_comes_from_option_then_env_then_file_then_default(config, monkeypatch):
    assert publish_choice() == ("off", "default")
    write_config(publish="auto")
    assert publish_choice() == ("auto", "file")
    monkeypatch.setenv("MYRMO_PUBLISH", "ask")
    assert publish_choice() == ("ask", "env")
    assert publish_choice("off") == ("off", "option")
    monkeypatch.setenv("MYRMO_PUBLISH", "nonsense")
    assert publish_choice() == ("auto", "file")  # an invalid value is ignored, not trusted


def test_the_client_uses_the_saved_choice(config):
    write_config(publish="auto")
    c, _ = colony(None)
    assert (c.publish_mode, c.publish_source) == ("auto", "file")


def test_config_command_saves_and_rejects(config, capsys):
    assert cli(["config", "publish", "ask"]) == 0
    assert read_config() == {"publish": "ask"}
    assert cli(["config", "publish", "sometimes"]) == 2
    assert cli(["config"]) == 0
    assert "publish: ask" in capsys.readouterr().out
