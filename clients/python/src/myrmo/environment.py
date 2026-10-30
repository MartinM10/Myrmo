"""Coarse environment detection. Never includes hostnames, paths or environment variables."""

from __future__ import annotations

import os
import platform
from importlib import metadata
from typing import Dict, Iterable, Union

_OS = {"linux": "linux", "darwin": "macos", "windows": "windows", "freebsd": "freebsd"}
_ARCH = {"x86_64": "x86_64", "amd64": "x86_64", "arm64": "arm64", "aarch64": "arm64", "i386": "x86", "i686": "x86", "x86": "x86", "riscv64": "riscv64"}


def _container() -> str:
    try:
        if os.path.exists("/.dockerenv"):
            return "docker"
        if os.environ.get("KUBERNETES_SERVICE_HOST"):
            return "kubernetes"
        if "microsoft" in platform.release().lower():
            return "wsl"
    except Exception:  # detection is best effort
        pass
    return "none"


def detect_environment(packages: Iterable[Union[str, Dict[str, str]]] = ()) -> Dict[str, object]:
    """OS, architecture, container kind and the Python runtime, plus versions of the named packages."""
    return {
        "os": _OS.get(platform.system().lower(), "other"),
        "arch": _ARCH.get(platform.machine().lower(), "other"),
        "container": _container(),
        "runtime": {"name": "python", "version": platform.python_version()},
        "packages": [parse_package(p) for p in packages],
    }


def parse_package(spec: Union[str, Dict[str, str]]) -> Dict[str, str]:
    """`"numpy@1.24.4"` or `"numpy==1.24.4"` -> `{"name": "numpy", "version": "1.24.4"}`.
    A bare name gets the installed version when the package is installed here."""
    if isinstance(spec, dict):
        return spec
    for sep in ("==", "@"):
        name, found, version = spec.rpartition(sep)
        if found and name:
            return {"name": name, "version": version}
    try:
        return {"name": spec, "version": metadata.version(spec), "ecosystem": "pypi"}
    except metadata.PackageNotFoundError:
        return {"name": spec}
