"""Which versions of a package an environment tells apart, so that a trail written for react 17 is not offered as if it
were for react 18. The colony and the TypeScript SDK do the same; all three reproduce
protocol/package_versions.v1.vectors.json."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence

_VERSION = re.compile(r"^[\s^~=<>!vV]*(\d+)(?:\.(\d+))?")


def major_of(version: Optional[str]) -> Optional[str]:
    """The part of a version that tells releases apart: the major (``18.2.0`` -> ``18``), or major.minor while the major
    is 0 (``0.20.1`` -> ``0.20``), since a 0.x release may break. A leading ``v``, ``^``, ``~``, ``=``, ``<`` or ``>``
    is ignored. None when the version holds no number (``latest``)."""
    if not isinstance(version, str):
        return None
    m = _VERSION.match(version)
    if not m:
        return None
    major = str(int(m.group(1)))
    return f"0.{int(m.group(2))}" if major == "0" and m.group(2) is not None else major


def package_mismatches(mine: Optional[Sequence[Dict[str, Any]]], trail: Optional[Sequence[Dict[str, Any]]]) -> List[Dict[str, str]]:
    """The packages the caller has that the trail names in another major version, in the caller's order, as
    ``{"name", "yours", "trail"}``. A package without a version on either side never mismatches, and neither does one
    the trail does not name."""
    if not mine or not trail:
        return []
    out: List[Dict[str, str]] = []
    for m in mine:
        name = m.get("name")
        ours = major_of(m.get("version"))
        if not name or ours is None:
            continue
        named = next((p for p in trail if isinstance(p.get("name"), str) and p["name"].lower() == name.lower() and major_of(p.get("version")) is not None), None)
        if named is not None and major_of(named.get("version")) != ours:
            out.append({"name": name, "yours": str(m["version"]), "trail": str(named["version"])})
    return out
