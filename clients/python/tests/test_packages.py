import json
from pathlib import Path

import pytest

from myrmo import detect_packages, detect_runtime

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "protocol/project_packages.v1.vectors.json").read_text(encoding="utf-8"))


def project(tmp_path, files):
    for name, content in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("case", VECTORS["packages"], ids=lambda c: c["why"][:60])
def test_detect_packages_reproduces_the_shared_vectors(tmp_path, case):
    options = case["options"]
    found = detect_packages(
        project(tmp_path, case["files"]),
        query=options.get("query", ""),
        scoped=options.get("scoped", False),
        only_named=options.get("onlyNamed", False),
        max=options.get("max", 30),
    )
    assert found == case["expected"]


@pytest.mark.parametrize("case", VECTORS["runtime"], ids=lambda c: c["why"][:60])
def test_detect_runtime_reproduces_the_shared_vectors(tmp_path, case):
    assert detect_runtime(project(tmp_path, case["files"])) == case["expected"]


def test_the_opt_out_reads_nothing(tmp_path, monkeypatch):
    project(tmp_path, {"package.json": {"dependencies": {"react": "18.2.0"}}})
    monkeypatch.setenv("MYRMO_DETECT_PACKAGES", "0")
    assert detect_packages(tmp_path) == []
    assert detect_runtime(tmp_path) is None


def _recording_colony(seen):
    import httpx

    from myrmo import Colony

    def handler(request):
        if request.url.path.startswith("/v1/trails/by-fingerprint/"):
            return httpx.Response(404, json={"error": {"code": "not_found", "message": "none"}})
        if request.url.path == "/v1/search":
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"fingerprint": "fp2_abc", "notice": "n", "results": []})
        return httpx.Response(404, json={})

    return Colony(url="https://colony.example", agent_id=False, publish="off", transport=httpx.MockTransport(handler))


def test_a_session_reads_the_project_when_it_is_given_no_packages_and_obeys_a_list_when_it_is(tmp_path, monkeypatch):
    from myrmo import Session

    project(tmp_path, {"package.json": {"dependencies": {"react": "^18.2.0"}}})
    monkeypatch.chdir(tmp_path)
    seen = []
    Session(_recording_colony(seen), task="render a list").failed("Error: react does not like this", "tried a key")
    assert seen[-1]["environment"]["packages"] == [{"name": "react", "version": "^18.2.0"}]
    Session(_recording_colony(seen), task="render a list", packages=[]).failed("Error: react does not like this", "tried a key")
    assert not seen[-1]["environment"].get("packages")
    Session(_recording_colony(seen), task="render a list", packages=["vue@3.4.0"]).failed("Error: react does not like this", "tried a key")
    assert seen[-1]["environment"]["packages"] == [{"name": "vue", "version": "3.4.0"}]


def test_a_published_draft_carries_the_dependencies_its_text_names(tmp_path, monkeypatch):
    from myrmo import Session, Verification

    project(tmp_path, {"package.json": {"dependencies": {"react": "^18.2.0", "lodash": "4.17.21"}}})
    monkeypatch.chdir(tmp_path)
    session = Session(_recording_colony([]), task="render a list")
    session.failed("Error: react does not like this call", "tried a key")
    draft = session.succeeded(Verification("test_suite", "tests pass", command="pytest -q", evidence="3 passed"), "react 18 rejects the call", ["Pass a stable key"])
    assert draft["environment"]["packages"] == [{"name": "react", "version": "^18.2.0"}]
