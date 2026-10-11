"""Service configuration, format 3: settings live in sections."""
import pathlib
import tomllib

SECTIONS = {"service": {"name"}, "server": {"port", "workers"}, "logging": {"level"}, "db": {"url"}}
REQUIRED = [("service", "name"), ("server", "port"), ("db", "url")]
LEVELS = {"debug", "info", "warning", "error"}


class ConfigError(Exception):
    pass


def line_of(text, key):
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(f"{key} ") or stripped.startswith(f"{key}=") or stripped == f"[{key}]":
            return number
    return 0


def load(path):
    text = pathlib.Path(path).read_text()
    name = pathlib.Path(path).name
    data = tomllib.loads(text)
    if data.get("config_version") != 3:
        raise ConfigError(f"E1042 at {name}:{line_of(text, 'config_version')}")
    for key, value in data.items():
        if key == "config_version":
            continue
        if key not in SECTIONS or not isinstance(value, dict):
            raise ConfigError(f"E1043 at {name}:{line_of(text, key)}")
        for inner in value:
            if inner not in SECTIONS[key]:
                raise ConfigError(f"E1043 at {name}:{line_of(text, inner)}")
    for section, key in REQUIRED:
        if key not in data.get(section, {}):
            raise ConfigError(f"E1044 at {name}:0")
    if data.get("logging", {}).get("level", "info") not in LEVELS:
        raise ConfigError(f"E1045 at {name}:{line_of(text, 'level')}")
    return data
