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
    assert [(l.signal, l.package) for l in leads] == [("runtime-floor", "b"), ("runtime-floor", "a"), ("major", "b"), ("major", "a")]
