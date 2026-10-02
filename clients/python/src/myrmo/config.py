"""The user's own Myrmo settings, one small file shared with the TypeScript clients and the
MCP server:

    ~/.myrmo/config.json      {"publish": "auto"}

It records a choice only a person should make: whether agents may publish for them. Write it
with `python -m myrmo config publish auto|ask|off`, never from agent code.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Optional, Tuple

MODES = ("off", "ask", "auto")


def config_path() -> Path:
    """`MYRMO_CONFIG` if set, else `~/.myrmo/config.json`."""
    override = os.environ.get("MYRMO_CONFIG", "").strip()
    return Path(override) if override else Path.home() / ".myrmo" / "config.json"


def read_config() -> Dict[str, str]:
    try:
        raw = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # missing or unreadable: no choice has been made
    publish = raw.get("publish") if isinstance(raw, dict) else None
    return {"publish": publish} if publish in MODES else {}


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
