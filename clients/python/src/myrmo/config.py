"""The user's own Myrmo settings, one small file shared with the TypeScript clients and the
MCP server:

    ~/.myrmo/config.json      {"publish": "auto", "agent_id": "3f9c0a7e2b1d4c68a5e0b7d91c2f4a86"}

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
from typing import Dict, Optional, Tuple, Union

MODES = ("off", "ask", "auto")
_AGENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def config_path() -> Path:
    """`MYRMO_CONFIG` if set, else `~/.myrmo/config.json`."""
    override = os.environ.get("MYRMO_CONFIG", "").strip()
    return Path(override) if override else Path.home() / ".myrmo" / "config.json"


def read_config() -> Dict[str, str]:
    try:
        raw = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # missing or unreadable: no choice has been made
    if not isinstance(raw, dict):
        return {}
    config: Dict[str, str] = {}
    if raw.get("publish") in MODES:
        config["publish"] = raw["publish"]
    if isinstance(raw.get("agent_id"), str) and _AGENT_ID.match(raw["agent_id"]):
        config["agent_id"] = raw["agent_id"]
    return config


def write_config(**patch: str) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**read_config(), **patch}, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass  # not supported on every platform


def publish_choice(explicit: Optional[str] = None) -> Tuple[str, str]:
    """`(mode, source)`. `source` is "option", "env", "file" or "default"; "default" means nobody
    has chosen yet, so the clients publish nothing and explain how to choose."""
    if explicit in MODES:
        return explicit, "option"
    from_env = os.environ.get("MYRMO_PUBLISH", "").strip()
    if from_env in MODES:
        return from_env, "env"
    from_file = read_config().get("publish")
    if from_file:
        return from_file, "file"
    return "off", "default"


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
    stored = read_config().get("agent_id")
    if stored:
        return stored, "file"
    generated = uuid.uuid4().hex
    try:
        write_config(agent_id=generated)
    except OSError:
        pass  # a read-only home directory: the id then lasts as long as this process
    return generated, "generated"
