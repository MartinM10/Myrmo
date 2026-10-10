"""Breakage radar: recent releases of widely used packages that are likely to break someone's build.

    python tools/seed-factory/radar.py                 # last 120 days, writes candidates/_radar.json
    python tools/seed-factory/radar.py --days 60 --top 20

A colony is worth most on what a model cannot know: breakages in releases newer than its training. MyrmoBench showed it
(a capable model solves the old, well-known breakages at once). This reads the public registries of PyPI and npm for a
watch list of packages and reports, for the last N days:

  major          a new major version (semver), the usual source of removed or renamed APIs
  runtime-floor  a release that raises the minimum Python (`requires_python`) or Node (`engines.node`)
  esm-only       an npm package whose new major is an ES module with no CommonJS entry left
  yanked         a recent version withdrawn (PyPI yanked, npm deprecated), often after it broke installs

Each lead is a place to look, not a trail: someone (or an agent) reproduces the breakage in a pinned image, writes the
task in catalog/, and the factory turns it into a trail only once it fails and its fix passes. The registries are used
for discovery only, as the provenance policy allows: nothing from them is copied into a trail. Nothing is published.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "candidates" / "_radar.json"
USER_AGENT = "myrmo-seed-radar/1.0 (+https://myrmo.dev)"

#: Packages whose breaking releases reach many agents. Kept short on purpose: a lead is only worth reading if a lot of
#: people install the package.
WATCH = {
    "pypi": [
        "numpy", "pandas", "scipy", "requests", "urllib3", "httpx", "pydantic", "fastapi", "starlette", "flask", "werkzeug",
        "django", "sqlalchemy", "celery", "redis", "boto3", "pytest", "setuptools", "pip", "poetry", "uv", "black", "ruff",
        "mypy", "torch", "transformers", "tensorflow", "scikit-learn", "matplotlib", "pillow", "openai", "anthropic",
        "langchain", "protobuf", "grpcio", "cryptography", "pyyaml", "jinja2", "click", "typer", "aiohttp", "psycopg",
    ],
    "npm": [
        "react", "react-dom", "next", "vite", "webpack", "typescript", "eslint", "prettier", "jest", "vitest", "tailwindcss",
        "postcss", "express", "axios", "node-fetch", "chalk", "commander", "yargs", "uuid", "nanoid", "glob", "rimraf",
        "dotenv", "prisma", "@prisma/client", "mongoose", "pg", "sqlite3", "better-sqlite3", "sharp", "puppeteer",
        "playwright", "esbuild", "@babel/core", "ts-node", "tsx", "pnpm", "yarn", "zod", "openai", "@anthropic-ai/sdk",
    ],
}


@dataclass(frozen=True)
class Lead:
    ecosystem: str
    package: str
    version: str
    released: str  # ISO date
    signal: str
    detail: str
    source: str  # the registry page the lead came from (discovery only)


def get_json(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers={"user-agent": USER_AGENT, "accept": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def parse_version(v: str) -> tuple[int, ...] | None:
    """`1.2.3` → (1, 2, 3); pre-releases and anything that is not plain numbers are skipped (None)."""
    m = re.fullmatch(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", v.strip())
    return tuple(int(x or 0) for x in m.groups()) if m else None


def minimum(spec: str | None) -> tuple[int, ...] | None:
    """The lowest version a requirement such as `>=3.10`, `^18.18.0 || >=20` or `>=3.9,<4` allows."""
    if not spec:
        return None
    found = [parse_version(m) for m in re.findall(r"(?:>=|\^|~|>|=)\s*v?(\d+(?:\.\d+){0,2})", spec)]
    found = [f for f in found if f]
    return min(found) if found else None


def fmt(v: tuple[int, ...] | None) -> str:
    return ".".join(map(str, v)) if v else "?"


def pypi_leads(package: str, data: dict, since: datetime) -> list[Lead]:
    """Leads from PyPI's JSON API (`/pypi/<package>/json`)."""
    releases = []
    for version, files in (data.get("releases") or {}).items():
        parsed = parse_version(version)
        if not parsed or not files:
            continue
        uploaded = min(datetime.fromisoformat(f["upload_time_iso_8601"].replace("Z", "+00:00")) for f in files)
        floor = minimum(next((f.get("requires_python") for f in files if f.get("requires_python")), None))
        yanked = all(f.get("yanked") for f in files)
        reason = next((f.get("yanked_reason") for f in files if f.get("yanked_reason")), "") or ""
        releases.append((parsed, version, uploaded, floor, yanked, reason))
    releases.sort()
    source = f"https://pypi.org/project/{package}/"
    leads, previous = [], None
    for parsed, version, uploaded, floor, yanked, reason in releases:
        if uploaded >= since:
            day = uploaded.date().isoformat()
            if yanked:
                leads.append(Lead("pypi", package, version, day, "yanked", reason or "withdrawn from PyPI", source))
            elif previous and parsed[0] > previous[0][0]:
                leads.append(Lead("pypi", package, version, day, "major", f"{previous[1]} -> {version}", source))
            if not yanked and previous and floor and previous[3] and floor > previous[3]:
                leads.append(Lead("pypi", package, version, day, "runtime-floor",
                                  f"requires Python {fmt(floor)} (was {fmt(previous[3])})", source))
        if not yanked:
            previous = (parsed, version, uploaded, floor)
    return leads


def is_esm_only(manifest: dict) -> bool:
    """An ES module whose exports offer no CommonJS entry: `require()` of it fails on older Node."""
    if manifest.get("type") != "module":
        return False
    exports = json.dumps(manifest.get("exports") or {})
    return '"require"' not in exports and not str(manifest.get("main", "")).endswith(".cjs")


def npm_leads(package: str, data: dict, since: datetime) -> list[Lead]:
    """Leads from the npm registry's packument (`registry.npmjs.org/<package>`)."""
    times = data.get("time") or {}
    versions = data.get("versions") or {}
    ordered = sorted((parse_version(v), v) for v in versions if parse_version(v))
    source = f"https://www.npmjs.com/package/{package}"
    leads, previous = [], None
    for parsed, version in ordered:
        manifest = versions[version]
        when = times.get(version)
        released = datetime.fromisoformat(when.replace("Z", "+00:00")) if when else None
        engines = manifest.get("engines")  # some old manifests have a list here
        floor = minimum(engines.get("node") if isinstance(engines, dict) else None)
        if released and released >= since:
            day = released.date().isoformat()
            if manifest.get("deprecated"):
                leads.append(Lead("npm", package, version, day, "yanked", str(manifest["deprecated"])[:200], source))
            elif previous and parsed[0] > previous[0][0]:
                leads.append(Lead("npm", package, version, day, "major", f"{previous[1]} -> {version}", source))
                if is_esm_only(manifest) and not is_esm_only(previous[3]):
                    leads.append(Lead("npm", package, version, day, "esm-only", "no CommonJS entry any more: require() fails", source))
            if previous and floor and previous[2] and floor > previous[2]:
                leads.append(Lead("npm", package, version, day, "runtime-floor",
                                  f"requires Node {fmt(floor)} (was {fmt(previous[2])})", source))
        if not manifest.get("deprecated"):
            previous = (parsed, version, floor, manifest)
    return leads


def fetch(ecosystem: str, package: str) -> dict:
    if ecosystem == "pypi":
        return get_json(f"https://pypi.org/pypi/{urllib.parse.quote(package)}/json")
    # A scoped name keeps its @ and has its slash encoded: @prisma/client -> @prisma%2Fclient.
    return get_json(f"https://registry.npmjs.org/{urllib.parse.quote(package, safe='@')}")


SIGNAL_ORDER = {"esm-only": 0, "runtime-floor": 1, "major": 2, "yanked": 3}


def scan(days: int, now: datetime | None = None, fetcher=fetch, watch: dict | None = None) -> tuple[list[Lead], list[str]]:
    since = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    leads, errors = [], []
    for ecosystem, packages in (watch or WATCH).items():
        parse = pypi_leads if ecosystem == "pypi" else npm_leads
        for package in packages:
            try:
                leads += parse(package, fetcher(ecosystem, package), since)
            except Exception as err:  # one package down must not stop the scan
                errors.append(f"{ecosystem}/{package}: {err}")
    # The rarest, most telling signals first; within each, the newest first.
    leads.sort(key=lambda l: l.released, reverse=True)
    leads.sort(key=lambda l: SIGNAL_ORDER.get(l.signal, 9))
    return leads, errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=120, help="how far back to look (default 120)")
    parser.add_argument("--top", type=int, default=30, help="leads to print (all are written to the file)")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    leads, errors = scan(args.days)
    args.out.write_text(json.dumps({"generated": datetime.now(timezone.utc).date().isoformat(), "days": args.days,
                                    "leads": [asdict(l) for l in leads], "errors": errors}, indent=1) + "\n",
                        encoding="utf-8")
    for l in leads[: args.top]:
        print(f"{l.released}  {l.signal:13} {l.ecosystem:4} {l.package} {l.version}: {l.detail}")
    print(f"\n{len(leads)} leads in the last {args.days} days -> {args.out.relative_to(HERE.parents[1])}"
          + (f"; {len(errors)} packages could not be read" if errors else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
