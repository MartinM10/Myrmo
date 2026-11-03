"""The packages and runtime a project declares, read from its own files, so a search can say which versions the caller
has without the model having to. Only names and versions of direct dependencies leave the project: no paths, no
registry addresses. Best effort: a file that cannot be read or parsed is skipped. The TypeScript SDK and the Claude Code
plugin's hook read the same way (protocol/project_packages.v1.vectors.json)."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

MAX_DETECTED_PACKAGES = 30

_NOT_REGISTRY = re.compile(r"^(workspace:|file:|link:|portal:|git|github:|https?:|npm:)|[\\/]", re.I)


def _read(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8") if path.is_file() else None
    except (OSError, UnicodeDecodeError):
        return None


def _node(cwd: Path, scoped: bool) -> List[Dict[str, str]]:
    text = _read(cwd / "package.json")
    if text is None:
        return []
    try:
        manifest = json.loads(text)
    except ValueError:
        return []
    if not isinstance(manifest, dict):
        return []
    lock: Any = None
    raw = _read(cwd / "package-lock.json")
    if raw:
        try:
            lock = json.loads(raw)
        except ValueError:
            lock = None
    own = manifest.get("name") if isinstance(manifest.get("name"), str) else ""
    out: List[Dict[str, str]] = []
    for field in ("dependencies", "devDependencies", "optionalDependencies"):
        deps = manifest.get(field)
        if not isinstance(deps, dict):
            continue
        for name, spec in deps.items():
            if not isinstance(spec, str) or name == own or _NOT_REGISTRY.search(spec.strip()):
                continue
            if not scoped and name.startswith("@"):
                continue
            installed = None
            if isinstance(lock, dict):
                entry = (lock.get("packages") or {}).get(f"node_modules/{name}") or (lock.get("dependencies") or {}).get(name)
                installed = entry.get("version") if isinstance(entry, dict) else None
            out.append({"name": name, "version": installed if isinstance(installed, str) else spec.strip()})
    return out


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.lower())


_REQUIREMENT = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:(===?|~=)\s*([A-Za-z0-9.*+!_-]+))?")


def _requirement(line: str) -> Optional[Dict[str, str]]:
    """`numpy[extra]==1.24.4 ; python_version > "3"` -> numpy 1.24.4; only `==` and `~=` name a release."""
    spec = line.split("#")[0].split(";")[0].strip()
    if not spec or spec.startswith("-") or re.search(r"[\\/@]|://", re.sub(r"\[[^\]]*\]", "", spec)):
        return None
    m = _REQUIREMENT.match(spec)
    if not m:
        return None
    if m.group(3) and "*" not in m.group(3):
        return {"name": m.group(1), "version": m.group(3)}
    return {"name": m.group(1)}


def _locked(text: Optional[str]) -> Dict[str, str]:
    """`[[package]]` blocks of poetry.lock and uv.lock: the release each package is installed at."""
    out: Dict[str, str] = {}
    if not text:
        return out
    for block in re.split(r"^\[\[package\]\]\s*$", text, flags=re.M)[1:]:
        name = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
        version = re.search(r'^version\s*=\s*"([^"]+)"', block, re.M)
        if name and version:
            out[_normalize(name.group(1))] = version.group(1)
    return out


def _python(cwd: Path) -> List[Dict[str, str]]:
    found: List[Dict[str, str]] = []
    for file in ("requirements.txt", "requirements-dev.txt", "requirements/base.txt", "requirements/prod.txt"):
        for line in (_read(cwd / file) or "").splitlines():
            p = _requirement(line)
            if p:
                found.append(p)
    pyproject = _read(cwd / "pyproject.toml")
    if pyproject:
        project = re.search(r"^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)^\]", pyproject, re.M)
        for m in re.finditer(r'"([^"]+)"', project.group(1) if project else ""):
            p = _requirement(m.group(1))
            if p:
                found.append(p)
        poetry = re.search(r"^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[|\Z)", pyproject, re.M)
        entry = re.compile(r'^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)"[^}]*\})', re.M)
        for m in entry.finditer(poetry.group(1) if poetry else ""):
            if m.group(1).lower() == "python":
                continue
            spec = (m.group(2) if m.group(2) is not None else m.group(3) or "").strip()
            item = {"name": m.group(1)}
            if spec and not _NOT_REGISTRY.search(spec):
                item["version"] = spec
            found.append(item)
    installed = {**_locked(_read(cwd / "poetry.lock")), **_locked(_read(cwd / "uv.lock"))}
    return [{"name": p["name"], "version": installed[_normalize(p["name"])]} if _normalize(p["name"]) in installed else p for p in found]


def detect_packages(
    cwd: Union[str, "os.PathLike[str]", None] = None,
    query: str = "",
    max: int = MAX_DETECTED_PACKAGES,  # noqa: A002 - the name the protocol's vectors use
    scoped: bool = False,
    only_named: bool = False,
) -> List[Dict[str, str]]:
    """The direct dependencies of the project in `cwd`: Node (`package.json`, with the release `package-lock.json` pins)
    and Python (`requirements*.txt`, `pyproject.toml`, with the release `poetry.lock` or `uv.lock` pins). Names the error
    text mentions come first, then the manifest's order, at most `max`. Scoped npm names (`@scope/name`) are left out
    unless `scoped` (the colony is the organisation's own); `only_named` keeps only the packages the text names, for a
    trail. `MYRMO_DETECT_PACKAGES=0` turns it off."""
    if os.environ.get("MYRMO_DETECT_PACKAGES") == "0":
        return []
    root = Path(cwd if cwd is not None else os.getcwd())
    seen = set()
    everything: List[Dict[str, str]] = []
    for p in _node(root, scoped) + _python(root):
        key = _normalize(p["name"])
        if key in seen:
            continue
        seen.add(key)
        everything.append(p)
    text = (query or "").lower()

    def named(p: Dict[str, str]) -> bool:
        # `pkg-3` is not named by a text about `pkg-37`: the name must stand alone.
        return bool(text) and re.search(r"(^|[^a-z0-9._@/-])" + re.escape(p["name"].lower()) + r"($|[^a-z0-9._-])", text) is not None

    ordered = [p for p in everything if named(p)] + ([] if only_named else [p for p in everything if not named(p)])
    return ordered[:max]


def _version_file(path: Path) -> Optional[str]:
    lines = (_read(path) or "").splitlines()
    first = re.sub(r"^v", "", lines[0].strip(), flags=re.I) if lines else ""
    return first if re.fullmatch(r"\d+\.\d+(\.\d+)?", first) else None


def detect_runtime(cwd: Union[str, "os.PathLike[str]", None] = None) -> Optional[Dict[str, str]]:
    """The language runtime of the project in `cwd`: `node` when it has a `package.json`, `python` when it has Python
    manifests, nothing when it has both or neither (a guess would be wrong half the time). The release only when the
    project pins one in `.nvmrc`, `.node-version` or `.python-version`."""
    if os.environ.get("MYRMO_DETECT_PACKAGES") == "0":
        return None
    root = Path(cwd if cwd is not None else os.getcwd())
    is_node = (root / "package.json").exists()
    is_python = any((root / f).exists() for f in ("pyproject.toml", "requirements.txt", "Pipfile", "setup.py"))
    if is_node == is_python:
        return None
    version = (_version_file(root / ".nvmrc") or _version_file(root / ".node-version")) if is_node else _version_file(root / ".python-version")
    out = {"name": "node" if is_node else "python"}
    if version:
        out["version"] = version
    return out
