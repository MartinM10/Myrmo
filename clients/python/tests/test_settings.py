"""Every setting has a default and works with no file at all; the file only records what a person chose.
Order for each one: explicit argument, environment variable, settings file, default."""

import json

import httpx
import pytest

from conftest import FakeColony
from myrmo import Colony, agent_identity, min_failed_attempts, read_config, set_setting, settings_report, write_config
from myrmo.__main__ import main as cli
from myrmo.format import attempts_phrase, format_result
from myrmo.client import SearchResult
from myrmo.session import Session


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MYRMO_CONFIG", str(tmp_path / "config.json"))
    for key in ("MYRMO_MIN_FAILED_ATTEMPTS", "MYRMO_PUBLISH", "MYRMO_HOOK", "MYRMO_ANONYMOUS", "MYRMO_AGENT_ID", "MYRMO_AGENT_MODEL"):
        monkeypatch.delenv(key, raising=False)
    return tmp_path / "config.json"


def rows():
    return {r["key"]: r for r in settings_report()}


def test_with_no_file_every_setting_has_its_default():
    r = rows()
    assert (r["publish"]["value"], r["publish"]["source"]) == ("ask", "default")
    assert (r["min-failed-attempts"]["value"], r["min-failed-attempts"]["source"]) == ("1", "default")
    assert (r["hook"]["value"], r["anonymous"]["value"]) == ("on", "false")
    assert all(x["source"] == "default" for x in r.values())


def test_the_minimum_of_failed_attempts_follows_argument_environment_file_default(monkeypatch):
    assert min_failed_attempts() == (1, "default")
    write_config(min_failed_attempts=4)
    assert min_failed_attempts() == (4, "file")
    monkeypatch.setenv("MYRMO_MIN_FAILED_ATTEMPTS", "2")
    assert min_failed_attempts() == (2, "env")
    assert min_failed_attempts(3) == (3, "option")


def test_nonsense_is_ignored_never_fatal(isolated, monkeypatch):
    for bad in ("lots", "", "-1", "21", "1.5"):
        monkeypatch.setenv("MYRMO_MIN_FAILED_ATTEMPTS", bad)
        assert min_failed_attempts()[1] == "default", bad
    isolated.write_text(json.dumps({"min_failed_attempts": -3, "hook": "maybe", "anonymous": "yes", "publish": "sometimes"}))
    assert read_config() == {}
    isolated.write_text("not json at all")
    assert read_config() == {}


def test_set_setting_validates_saves_and_reset_restores_the_default(isolated):
    assert set_setting("min-failed-attempts", "3")[0] is True
    assert json.loads(isolated.read_text())["min_failed_attempts"] == 3
    assert set_setting("hook", "off")[0] and set_setting("anonymous", "true")[0] and set_setting("publish", "auto")[0]
    assert read_config() == {"min_failed_attempts": 3, "hook": "off", "anonymous": True, "publish": "auto"}
    for key, value in [("min-failed-attempts", "-1"), ("min-failed-attempts", "many"), ("min-failed-attempts", "21"), ("hook", "maybe"), ("anonymous", "yes"), ("publish", "sometimes"), ("colour", "blue")]:
        assert set_setting(key, value)[0] is False, (key, value)
    assert read_config()["min_failed_attempts"] == 3, "a refused value changes nothing"
    assert set_setting("min-failed-attempts", "reset")[0]
    assert "min_failed_attempts" not in read_config()
    assert read_config()["hook"] == "off", "the other settings stay"


def test_the_command_line_changes_any_setting(isolated, capsys):
    assert cli(["config", "min-failed-attempts", "3"]) == 0
    assert cli(["config", "hook", "off"]) == 0
    assert json.loads(isolated.read_text()) == {"min_failed_attempts": 3, "hook": "off"}
    assert cli(["config", "min-failed-attempts", "lots"]) == 2
    assert cli(["config", "colour", "blue"]) == 2
    assert cli(["config", "hook"]) == 2, "a setting without a value is a usage error, not a silent change"
    assert cli(["config", "min-failed-attempts", "reset"]) == 0
    assert json.loads(isolated.read_text()) == {"hook": "off"}


def test_anonymous_in_the_file_sends_no_agent_id(monkeypatch):
    write_config(anonymous=True)
    assert agent_identity() == (None, "none")
    monkeypatch.setenv("MYRMO_AGENT_ID", "chosen-by-the-user")
    assert agent_identity() == ("chosen-by-the-user", "env")


def test_the_session_uses_the_configured_minimum():
    colony = Colony(url="http://colony.test", transport=httpx.MockTransport(FakeColony()), cache_ttl=0)
    assert Session(colony, "task").min_failed_attempts == 1
    write_config(min_failed_attempts=3)
    assert Session(colony, "task").min_failed_attempts == 3
    assert Session(colony, "task", min_failed_attempts=2).min_failed_attempts == 2


def test_the_hint_after_a_search_with_no_match_follows_the_configured_minimum():
    none = SearchResult("fp1_0000000000000000", [], "untrusted", "search", {})
    assert "at least one failed attempt" in format_result(none)
    write_config(min_failed_attempts=3)
    assert "3 or more failed attempts" in format_result(none)
    assert "5 or more failed attempts" in format_result(none, min_failed_attempts=5)
    assert attempts_phrase(0) == "at least one failed attempt"


def test_the_hook_setting_takes_on_failures_or_off(monkeypatch):
    assert set_setting("hook", "failures")[0] is True
    assert read_config()["hook"] == "failures"
    assert rows()["hook"]["value"] == "failures"
    monkeypatch.setenv("MYRMO_HOOK", "off")
    assert (rows()["hook"]["value"], rows()["hook"]["source"]) == ("off", "env")
    monkeypatch.delenv("MYRMO_HOOK")
    ok, message = set_setting("hook", "sometimes")
    assert ok is False and "on, failures or off" in message
