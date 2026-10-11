"""Rewrites a format 2 service file (flat keys) as format 3, keeping every value; the old file is kept as .v2.bak."""
import pathlib
import shutil
import tomllib

MOVES = {"service_name": ("service", "name"), "listen_port": ("server", "port"), "workers": ("server", "workers"),
         "log_level": ("logging", "level"), "database_url": ("db", "url")}


def value(v):
    return f'"{v}"' if isinstance(v, str) else str(v).lower() if isinstance(v, bool) else str(v)


def migrate(path):
    path = pathlib.Path(path)
    old = tomllib.loads(path.read_text())
    if old.get("config_version") == 3:
        print(f"{path.name} is already format 3")
        return
    sections = {}
    for key, v in old.items():
        if key in MOVES:
            section, inner = MOVES[key]
            sections.setdefault(section, {})[inner] = v
        elif isinstance(v, dict):
            sections.setdefault(key, {}).update(v)
    shutil.copy(path, path.with_suffix(path.suffix + ".v2.bak"))
    lines = ["config_version = 3"]
    for section, values in sections.items():
        lines += ["", f"[{section}]"] + [f"{k} = {value(v)}" for k, v in values.items()]
    path.write_text("\n".join(lines) + "\n")
    print(f"migrated {path.name} to format 3 (backup: {path.name}.v2.bak)")
