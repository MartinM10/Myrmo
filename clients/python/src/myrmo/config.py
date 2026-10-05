"""The user's own Myrmo settings, one small file shared with the TypeScript clients and the
MCP server:

    ~/.myrmo/config.json      {"publish": "ask", "min_failed_attempts": 1, "hook": "on", "agent_id": "3f9c..."}

Everything works with no file at all: every setting has a default, and the file only records what a
person chose. For each setting the order is: an explicit argument, the environment variable, this
file, the default.

`publish` is a choice only a person should make: whether agents may publish for them. Write it
with `python -m myrmo config publish auto|ask|off`, never from agent code. `agent_id` is a random
pseudonym the client creates by itself the first time it runs, so that reports from different
machines behind one address are not mistaken for a single agent. It holds no personal data and can be
deleted at any time.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

MODES = ("off", "ask", "auto")
_AGENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
DEFAULT_MIN_FAILED_ATTEMPTS = 1
MAX_MIN_FAILED_ATTEMPTS = 20


def config_path() -> Path:
    """`MYRMO_CONFIG` if set, else `~/.myrmo/config.json`."""
    override = os.environ.get("MYRMO_CONFIG", "").strip()
    return Path(override) if override else Path.home() / ".myrmo" / "config.json"


def _parse_attempts(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value.lstrip("-").isdigit():
            return None
        value = int(value)
    if isinstance(value, int) and 0 <= value <= MAX_MIN_FAILED_ATTEMPTS:
        return value
    return None


def read_config() -> Dict[str, Any]:
    try:
        raw = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # missing or unreadable: no choice has been made
    if not isinstance(raw, dict):
        return {}
    config: Dict[str, Any] = {}
    if raw.get("publish") in MODES:
        config["publish"] = raw["publish"]
    if isinstance(raw.get("agent_id"), str) and _AGENT_ID.match(raw["agent_id"]):
        config["agent_id"] = raw["agent_id"]
    attempts = _parse_attempts(raw.get("min_failed_attempts"))
    if attempts is not None:
        config["min_failed_attempts"] = attempts
    if raw.get("hook") in ("on", "failures", "off"):
        config["hook"] = raw["hook"]
    if isinstance(raw.get("anonymous"), bool):
        config["anonymous"] = raw["anonymous"]
    return config


def write_config(**patch: Any) -> None:
    """Merge `patch` into the file. A key set to None is removed, which restores its default."""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = {**read_config(), **patch}
    merged = {k: v for k, v in merged.items() if v is not None}
    path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass  # not supported on every platform


def publish_choice(explicit: Optional[str] = None) -> Tuple[str, str]:
    """`(mode, source)`. `source` is "option", "env", "file" or "default"; "default" means nobody
    has chosen yet, so nothing is published until the user has been asked (the MCP server asks the
    first time an agent wants to publish, with "ask" preselected)."""
    if explicit in MODES:
        return explicit, "option"
    from_env = os.environ.get("MYRMO_PUBLISH", "").strip()
    if from_env in MODES:
        return from_env, "env"
    from_file = read_config().get("publish")
    if from_file:
        return from_file, "file"
    return "off", "default"


def min_failed_attempts(explicit: Optional[int] = None) -> Tuple[int, str]:
    """`(value, source)`: failed attempts before a fix is worth publishing. Argument, then
    MYRMO_MIN_FAILED_ATTEMPTS, then the settings file, then 1."""
    from_option = _parse_attempts(explicit)
    if from_option is not None:
        return from_option, "option"
    from_env = _parse_attempts(os.environ.get("MYRMO_MIN_FAILED_ATTEMPTS", ""))
    if from_env is not None:
        return from_env, "env"
    from_file = read_config().get("min_failed_attempts")
    if from_file is not None:
        return from_file, "file"
    return DEFAULT_MIN_FAILED_ATTEMPTS, "default"


#: What `python -m myrmo config` can change: name, settings-file key, accepted values, default, what it does.
SETTINGS = (
    ("publish", "publish", "ask | auto | off", "ask (asked the first time an agent wants to publish)", "Whether agents may publish fixes for you. ask shows you each one first."),
    ("min-failed-attempts", "min_failed_attempts", "0 to %d" % MAX_MIN_FAILED_ATTEMPTS, str(DEFAULT_MIN_FAILED_ATTEMPTS), "Failed attempts before a fix is worth publishing. Higher means fewer, more selective trails."),
    ("hook", "hook", "on | failures | off", "on", "Claude Code plugin reminders. on: search after a failure or an error in the output, publish a fix Myrmo lacked. failures: only after a failed command."),
    ("anonymous", "anonymous", "true | false", "false", "Send no agent id at all (reports then count by address)."),
)


def settings_report() -> List[Dict[str, str]]:
    """Every setting with its current value and where that value comes from."""
    file = read_config()
    mode, publish_source = publish_choice()
    attempts, attempts_source = min_failed_attempts()
    hook_env = os.environ.get("MYRMO_HOOK", "").strip().lower()
    anon_env = os.environ.get("MYRMO_ANONYMOUS", "").strip().lower()
    rows = {
        "publish": ("ask" if publish_source == "default" else mode, publish_source),
        "min-failed-attempts": (str(attempts), attempts_source),
        "hook": (hook_env, "env") if hook_env in ("on", "failures", "off") else ((file["hook"], "file") if "hook" in file else ("on", "default")),
        "anonymous": (str(anon_env in ("1", "true")).lower(), "env") if anon_env else ((str(file["anonymous"]).lower(), "file") if "anonymous" in file else ("false", "default")),
    }
    return [
        {"key": key, "value": rows[key][0], "source": rows[key][1], "values": values, "default": default, "about": about}
        for key, _file, values, default, about in SETTINGS
    ]


def set_setting(key: str, value: str) -> Tuple[bool, str]:
    """Change one setting from its CLI name. The value `reset` removes it from the file. `(ok, message)`."""
    entry = next((e for e in SETTINGS if e[0] == key), None)
    if entry is None:
        return False, 'Unknown setting "%s". Settings: %s.' % (key, ", ".join(e[0] for e in SETTINGS))
    if value == "reset":
        write_config(**{entry[1]: None})
        return True, "%s is back to its default (%s)." % (key, entry[3])
    if key == "publish":
        if value not in MODES:
            return False, "publish takes ask, auto or off."
        write_config(publish=value)
    elif key == "min-failed-attempts":
        attempts = _parse_attempts(value)
        if attempts is None:
            return False, "min-failed-attempts takes a whole number from 0 to %d." % MAX_MIN_FAILED_ATTEMPTS
        write_config(min_failed_attempts=attempts)
    elif key == "hook":
        if value not in ("on", "failures", "off"):
            return False, "hook takes on, failures or off."
        write_config(hook=value)
    else:
        if value not in ("true", "false"):
            return False, "anonymous takes true or false."
        write_config(anonymous=value == "true")
    return True, "Saved to %s: %s = %s." % (config_path(), key, value)


def agent_identity(explicit: Union[str, bool, None] = None) -> Tuple[Optional[str], str]:
    """`(id, source)`: who this client says it is. Nothing to configure: the first run creates a random
    id and keeps it in the config file. `MYRMO_AGENT_ID` (or the `agent_id` argument) overrides it;
    `agent_id=False` or `MYRMO_ANONYMOUS=1` sends none. If the file cannot be written the id lives for
    this process only. `source` is "option", "env", "file", "generated" or "none"."""
    if explicit is False:
        return None, "none"
    if explicit:
        return str(explicit), "option"
    from_env = os.environ.get("MYRMO_AGENT_ID", "").strip()
    if from_env:
        return from_env, "env"
    if os.environ.get("MYRMO_ANONYMOUS", "").strip().lower() in ("1", "true"):
        return None, "none"
    if read_config().get("anonymous") is True:
        return None, "none"
    stored = read_config().get("agent_id")
    if stored:
        return stored, "file"
    generated = uuid.uuid4().hex
    try:
        write_config(agent_id=generated)
    except OSError:
        pass  # a read-only home directory: the id then lasts as long as this process
    return generated, "generated"
