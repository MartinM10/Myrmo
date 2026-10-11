"""The breakage radar, on registry documents shaped like the real ones. No network."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import radar  # noqa: E402

NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)
SINCE = datetime(2026, 6, 12, tzinfo=timezone.utc)


def pypi_file(day, requires=None, yanked=False, reason=None):
    return {"upload_time_iso_8601": f"{day}T10:00:00.000000Z", "requires_python": requires, "yanked": yanked, "yanked_reason": reason}


def test_versions_and_requirements_are_read_like_the_registries_write_them():
    assert radar.parse_version("2.5.0") == (2, 5, 0) and radar.parse_version("v7") == (7, 0, 0)
    assert radar.parse_version("3.0.0rc1") is None and radar.parse_version("1.0.0-beta.2") is None
    assert radar.minimum(">=3.10") == (3, 10, 0)
    assert radar.minimum("^18.18.0 || >=20") == (18, 18, 0)
    assert radar.minimum(">=3.9,<4") == (3, 9, 0)
    assert radar.minimum(None) is None and radar.minimum("*") is None


def test_pypi_reports_a_new_major_a_raised_python_floor_and_a_yanked_release():
    data = {"releases": {
        "1.26.0": [pypi_file("2025-01-01", ">=3.9")],
        "2.0.0": [pypi_file("2026-07-01", ">=3.12")],
        "2.0.1": [pypi_file("2026-07-05", ">=3.12", yanked=True, reason="segfaults")],
        "2.1.0rc1": [pypi_file("2026-08-01", ">=3.12")],
        "0.9.0": [],
    }}
    leads = {(l.version, l.signal) for l in radar.pypi_leads("numpy", data, SINCE)}
    assert leads == {("2.0.0", "major"), ("2.0.0", "runtime-floor"), ("2.0.1", "yanked")}
    floor = next(l for l in radar.pypi_leads("numpy", data, SINCE) if l.signal == "runtime-floor")
    assert floor.detail == "requires Python 3.12.0 (was 3.9.0)" and floor.released == "2026-07-01"


def test_old_releases_are_not_leads():
    data = {"releases": {"1.0.0": [pypi_file("2024-01-01")], "2.0.0": [pypi_file("2025-01-01", ">=3.12")]}}
    assert radar.pypi_leads("x", data, SINCE) == []


def test_npm_reports_esm_only_majors_node_floors_and_deprecations():
    data = {
        "time": {"5.6.2": "2025-03-01T00:00:00Z", "6.0.0": "2026-07-26T00:00:00Z", "6.0.1": "2026-07-27T00:00:00Z"},
        "versions": {
            "5.6.2": {"type": "module", "exports": {"import": "./a.js", "require": "./a.cjs"}, "engines": {"node": ">=12.17"}},
            "6.0.0": {"type": "module", "exports": {".": "./a.js"}, "engines": {"node": ">=22"}},
            "6.0.1": {"type": "module", "exports": {".": "./a.js"}, "engines": {"node": ">=22"}, "deprecated": "broken, use 6.0.2"},
            "6.1.0-beta.1": {"type": "module"},
        },
    }
    leads = {(l.version, l.signal) for l in radar.npm_leads("chalk", data, SINCE)}
    assert leads == {("6.0.0", "major"), ("6.0.0", "esm-only"), ("6.0.0", "runtime-floor"), ("6.0.1", "yanked")}


def test_npm_manifests_with_odd_engines_do_not_stop_the_scan():
    data = {"time": {"1.0.0": "2026-07-01T00:00:00Z"}, "versions": {"1.0.0": {"engines": ["node >= 0.8"]}}}
    assert radar.npm_leads("old", data, SINCE) == []


def test_a_package_that_cannot_be_read_is_reported_and_the_rest_still_scanned():
    def fetcher(ecosystem, package):
        if package == "down":
            raise OSError("timed out")
        return {"releases": {"1.0.0": [pypi_file("2025-01-01")], "2.0.0": [pypi_file("2026-09-01")]}}
    leads, errors = radar.scan(120, now=NOW, fetcher=fetcher, watch={"pypi": ["down", "up"]})
    assert [(l.package, l.signal) for l in leads] == [("up", "major")]
    assert errors == ["pypi/down: timed out"]


def test_leads_are_ordered_by_how_telling_the_signal_is_then_newest_first():
    def fetcher(ecosystem, package):
        return {"releases": {"1.0.0": [pypi_file("2025-01-01", ">=3.8")],
                             "2.0.0": [pypi_file("2026-07-01" if package == "a" else "2026-09-01", ">=3.12")]}}
    leads, _ = radar.scan(120, now=NOW, fetcher=fetcher, watch={"pypi": ["a", "b"]})
    # A Python floor comes after a major (see test_a_raised_python_floor_comes_after_every_other_signal); newest first within each.
    assert [(l.signal, l.package) for l in leads] == [("major", "b"), ("major", "a"), ("runtime-floor", "b"), ("runtime-floor", "a")]


def test_a_raised_python_floor_comes_after_every_other_signal():
    def fetcher(ecosystem, package):
        if ecosystem == "pypi":
            return {"releases": {"1.0.0": [pypi_file("2025-01-01", ">=3.8")], "1.1.0": [pypi_file("2026-09-01", ">=3.12")]}}
        return {"time": {"1.0.0": "2025-01-01T00:00:00Z", "2.0.0": "2026-08-01T00:00:00Z"},
                "versions": {"1.0.0": {}, "2.0.0": {"deprecated": "broken"}}}
    leads, _ = radar.scan(120, now=NOW, fetcher=fetcher, watch={"pypi": ["p"], "npm": ["n"]})
    assert [(l.ecosystem, l.signal) for l in leads] == [("npm", "yanked"), ("pypi", "runtime-floor")]


def lead(**kw):
    base = dict(ecosystem="npm", package="typescript", version="7.0.2", released="2026-07-08", signal="major", detail="", source="s",
                repo="microsoft/TypeScript")
    return radar.Lead(**{**base, **kw})


def fake_github(issues, licences):
    """A stand-in for `gh api`: search results by query text, and repository licences."""
    calls = []

    def call(path, **params):
        calls.append((path, params.get("q")))
        if path == "search/issues":
            return {"items": next((v for k, v in issues.items() if k in params["q"]), [])}
        repo = path.removeprefix("repos/")
        return {"license": {"spdx_id": licences[repo]}} if licences.get(repo) else {"license": None}
    call.calls = calls
    return call


def issue(repo, title, comments, login="someone", kind="User", **extra):
    return {"title": title, "html_url": f"https://github.com/{repo}/issues/{comments}", "comments": comments,
            "repository_url": f"https://api.github.com/repos/{repo}", "user": {"login": login, "type": kind}, **extra}


def test_the_repository_comes_from_what_the_registry_says_about_itself():
    assert radar.repo_of("pypi", {"info": {"project_urls": {"Source": "https://github.com/pydantic/pydantic"}}}) == "pydantic/pydantic"
    assert radar.repo_of("pypi", {"info": {"project_urls": None, "home_page": "https://github.com/a/b.git"}}) == "a/b"
    assert radar.repo_of("npm", {"repository": {"type": "git", "url": "git+https://github.com/vitest-dev/vitest.git"}}) == "vitest-dev/vitest"
    assert radar.repo_of("npm", {"repository": "github:owner/name", "homepage": "https://github.com/owner/name#readme"}) == "owner/name"
    assert radar.repo_of("npm", {"repository": {"url": "https://gitlab.com/x/y"}}) == ""


def test_evidence_keeps_problem_titles_from_repositories_with_an_accepted_licence():
    github = fake_github(
        {"repo:microsoft/TypeScript": [issue("microsoft/TypeScript", "Crash with the new emit: Cannot read properties of undefined", 4)],
         '"typescript" "7.0.2"': [issue("TypeStrong/ts-node", "ts-node doesn't work with Typescript 7.0.2", 8),
                                  issue("someone/copyleft", "TypeScript 7.0.2 breaks the build", 9),
                                  issue("someone/unlicensed", "TypeScript 7.0.2 breaks the build", 6),
                                  issue("TypeStrong/ts-node", "Support TypeScript 7 (feature request)", 12),
                                  issue("a/b", "TypeScript 7.0.2 fails on Node 20", 3, pull_request={})]},
        {"microsoft/TypeScript": "Apache-2.0", "TypeStrong/ts-node": "MIT", "someone/copyleft": "GPL-3.0-only", "a/b": "MIT"})
    found = radar.evidence_for(lead(), github, pause=0)
    assert [(e["repo"], e["comments"], e["licence"]) for e in found] == [("TypeStrong/ts-node", 8, "MIT"), ("microsoft/TypeScript", 4, "Apache-2.0")]
    assert not any("copyleft" in e["repo"] or "unlicensed" in e["repo"] for e in found), "a repository the policy does not accept is not used"
    assert not any("feature request" in e["title"] for e in found), "only titles that read like a problem"
    assert not any(e["comments"] == 3 for e in found), "pull requests are not reports"


def test_a_lead_without_a_repository_is_searched_by_name_and_version_only():
    github = fake_github({}, {})
    assert radar.evidence_for(lead(repo=""), github, pause=0) == ()
    assert [q for _, q in github.calls] == ['"typescript" "7.0.2" in:title,body is:issue created:>=2026-07-08']


def test_a_repository_licence_is_looked_up_once():
    github = fake_github({"typescript": [issue("a/b", "typescript boom fails", 2), issue("a/b", "typescript another crash", 1)]}, {"a/b": "MIT"})
    radar.evidence_for(lead(repo=""), github, pause=0)
    assert [p for p, _ in github.calls].count("repos/a/b") == 1


def test_only_the_first_leads_are_read_for_evidence_and_github_down_changes_nothing():
    leads = [lead(package=f"p{i}", repo="") for i in range(4)]
    out = radar.add_evidence(leads, 2, call=lambda path, **params: None, pause=0)
    assert [l.evidence for l in out] == [(), (), (), ()] and [l.package for l in out] == ["p0", "p1", "p2", "p3"]


def test_bots_and_titles_that_matched_by_chance_are_left_out():
    github = fake_github(
        {"repo:microsoft/TypeScript": [issue("microsoft/TypeScript", "[ServerErrors][TypeScript] main vs release-5.9", 22, login="typescript-bot"),
                                       issue("microsoft/TypeScript", "Crash on emit with decorators", 5),
                                       issue("microsoft/TypeScript", "Release tracking error", 9, login="dependabot[bot]", kind="Bot")],
         '"typescript" "7.0.2"': [issue("gweiermann/shopware", "Nightly npm audit failures", 17),
                                  issue("TypeStrong/ts-node", "ts-node fails with 7.0.2", 8),
                                  issue("a/b", "Build breaks with TypeScript", 4)]},
        {"microsoft/TypeScript": "Apache-2.0", "gweiermann/shopware": "MIT", "TypeStrong/ts-node": "MIT", "a/b": "MIT"})
    titles = [e["title"] for e in radar.evidence_for(lead(), github, pause=0)]
    assert titles == ["ts-node fails with 7.0.2", "Crash on emit with decorators", "Build breaks with TypeScript"]
