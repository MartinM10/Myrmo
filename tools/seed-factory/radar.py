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
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import provenance  # noqa: E402
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
    repo: str = ""  # `owner/name` of the package's source repository on GitHub, when it has one
    #: Public issues about this release (title, url, comments, repo, licence), read for discovery only: they tell the
    #: worker which error people actually hit. Only issues of repositories whose licence the policy accepts are kept.
    evidence: tuple = ()


GITHUB_REPO = re.compile(r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?]|$)", re.I)


def repo_of(ecosystem: str, data: dict) -> str:
    """`owner/name` of the package's GitHub repository, from what its registry says about itself ("" when it names none)."""
    if ecosystem == "pypi":
        info = data.get("info") or {}
        candidates = [*(info.get("project_urls") or {}).values(), info.get("home_page"), info.get("package_url")]
    else:
        repository = data.get("repository")
        candidates = [repository.get("url") if isinstance(repository, dict) else repository, data.get("homepage")]
    for url in candidates:
        match = GITHUB_REPO.search(str(url or ""))
        if match:
            return f"{match.group(1)}/{match.group(2)}"
    return ""


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


def priority(lead: Lead) -> int:
    """How telling a lead is. A raised Python floor comes last: pip names the Python version a release needs, so agents
    fix it at a glance and the workers rightly skip it (seen on pydantic 2.14 and sqlalchemy 2.1)."""
    if lead.ecosystem == "pypi" and lead.signal == "runtime-floor":
        return 9
    return SIGNAL_ORDER.get(lead.signal, 8)


def scan(days: int, now: datetime | None = None, fetcher=fetch, watch: dict | None = None) -> tuple[list[Lead], list[str]]:
    since = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    leads, errors = [], []
    for ecosystem, packages in (watch or WATCH).items():
        parse = pypi_leads if ecosystem == "pypi" else npm_leads
        for package in packages:
            try:
                data = fetcher(ecosystem, package)
                repo = repo_of(ecosystem, data)
                leads += [replace(lead, repo=repo) for lead in parse(package, data, since)]
            except Exception as err:  # one package down must not stop the scan
                errors.append(f"{ecosystem}/{package}: {err}")
    # The rarest, most telling signals first; within each, the newest first.
    leads.sort(key=lambda l: l.released, reverse=True)
    leads.sort(key=priority)
    return leads, errors


# --- what people report ---------------------------------------------------------------------------------------------

#: A title that reads like a problem and not like a question, a feature request or a chore.
PROBLEM = re.compile(r"error|fail|break|broke|crash|cannot|can't|couldn't|doesn't|does not|not work|no longer|regression|"
                     r"incompatib|undefined|exception|unexpected|missing|stack overflow|hang|deadlock|ERR_|segfault", re.I)


def gh(path: str, **params: str) -> dict | None:
    """GET a GitHub API path through the `gh` command, which carries the user's login: the search API allows 30 requests a
    minute that way and 10 without it. None when `gh` is not installed or the call fails."""
    args = ["gh", "api", "-X", "GET", path]
    for key, value in params.items():
        args += ["-f", f"{key}={value}"]
    try:
        done = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        return json.loads(done.stdout) if done.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def licence_of(repo: str, call, cache: dict) -> str:
    """The SPDX id of a repository's licence ("" when it has none or GitHub cannot tell)."""
    if repo not in cache:
        data = call(f"repos/{repo}") or {}
        spdx = (data.get("license") or {}).get("spdx_id") or ""
        cache[repo] = "" if spdx in ("NOASSERTION", "NONE") else spdx
    return cache[repo]


def evidence_for(lead: Lead, call=gh, cache: dict | None = None, pause: float = 2.2) -> tuple:
    """Public issues about this release: in the package's own repository since it came out, and in other repositories that
    name the exact version. Only titles that read like a problem, and only from repositories whose licence the policy
    accepts (a copyleft or unlicensed repository is not a source the project can build on, even for discovery)."""
    cache = {} if cache is None else cache
    queries = []
    if lead.repo:
        queries.append(f"repo:{lead.repo} is:issue created:>={lead.released}")
    queries.append(f'"{lead.package}" "{lead.version}" in:title,body is:issue created:>={lead.released}')
    found: dict[str, dict] = {}
    name = lead.package.split("/")[-1].lower()
    for q in queries:
        own = q.startswith("repo:")
        reply = call("search/issues", q=q, sort="comments", order="desc", per_page="10") or {}
        time.sleep(pause)
        for item in reply.get("items") or []:
            repo = "/".join(str(item.get("repository_url", "")).split("/")[-2:])
            title = " ".join(str(item.get("title", "")).split())
            user = item.get("user") or {}
            if not repo or not PROBLEM.search(title) or item.get("html_url") in found or "pull_request" in item:
                continue
            # A bot's issue is a tracker's own bookkeeping, not a person's report; and in somebody else's repository a title
            # that names neither the package nor the version only matched the search by chance.
            if user.get("type") == "Bot" or str(user.get("login", "")).lower().endswith("bot"):
                continue
            if not own and name not in title.lower() and lead.version not in title:
                continue
            licence = licence_of(repo, call, cache)
            time.sleep(pause)
            if provenance.licence_allowed(licence):
                found[item["html_url"]] = {"title": title[:200], "url": item["html_url"], "comments": int(item.get("comments") or 0),
                                           "repo": repo, "licence": licence}
    return tuple(sorted(found.values(), key=lambda e: e["comments"], reverse=True)[:5])


def add_evidence(leads: list[Lead], top: int, call=gh, pause: float = 2.2) -> list[Lead]:
    """The first `top` leads (the radar's order), each with what people report about it."""
    cache: dict = {}
    return [replace(lead, evidence=evidence_for(lead, call, cache, pause)) if i < top else lead for i, lead in enumerate(leads)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=120, help="how far back to look (default 120)")
    parser.add_argument("--top", type=int, default=30, help="leads to print (all are written to the file)")
    parser.add_argument("--evidence", type=int, default=12, metavar="N", help="read the public issues of the first N leads (0 skips it)")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    # Registry text may hold characters the Windows console cannot print: show them as "?" instead of stopping the radar.
    sys.stdout.reconfigure(errors="replace")
    leads, errors = scan(args.days)
    if args.evidence:
        if shutil.which("gh"):
            leads = add_evidence(leads, args.evidence)
        else:
            errors.append("evidence skipped: the `gh` command is not installed")
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
