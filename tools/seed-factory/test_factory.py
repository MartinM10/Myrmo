import copy
import importlib
import importlib.util
import json
import sys
import urllib.error
from pathlib import Path

import pytest

ROOT = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


factory = load("factory")
publisher = load("publisher")
retire = load("retire")
provenance = load("provenance")
sys.path.insert(0, str(ROOT))
catalog = importlib.import_module("catalog")
EXAMPLE = json.loads((ROOT.parents[1] / "protocol/examples/trail.distutils.json").read_text(encoding="utf-8"))


def candidate():
    """A schema-valid trail shaped like the factory's output."""
    c = copy.deepcopy(EXAMPLE)
    c["problem"]["error_message"] = "ModuleNotFoundError: No module named 'distutils'"
    c["effort"]["failed_attempts"] = 2
    c["_factory"] = {"task_id": "t", "failed": [{"exit_code": 1}, {"exit_code": 1}], "fixed": {"exit_code": 0}}
    c["_provenance"] = provenance_for(c)
    return c


def provenance_for(c, **kwargs):
    """The record the factory would attach to this trail."""
    return provenance.record(task_id="t", batch="b", image="python:3.12.4", digest="python@sha256:" + "a" * 64,
                             version={"commit": "abc123", "dirty": False}, public_trail={k: v for k, v in c.items() if not k.startswith("_")}, **kwargs)


def test_url_guard():
    assert publisher.allowed("http://localhost:8080")
    assert publisher.allowed("https://myrmo.dev")
    assert publisher.allowed("http://10.0.0.8:8080")
    assert publisher.allowed("https://[fd00::8]:8080")
    assert not publisher.allowed("https://example.com")
    assert not publisher.allowed("http://myrmo.dev")
    assert not publisher.allowed("https://myrmo.dev.evil.example")


def test_publisher_talks_only_to_trail_endpoints():
    for path in ("/v1/search", "/v1/analytics", "/readyz", "/v1/trails/../search"):
        if path.startswith("/v1/trails/"):
            continue
        with pytest.raises(RuntimeError):
            publisher.request("https://myrmo.dev", "GET", path)


def test_every_catalog_task_has_failed_and_fix():
    assert len(factory.TASKS) >= 10
    for task in factory.TASKS:
        assert task.failing_command and task.failed_approaches and task.fix_command and task.verification_command


def test_the_policy_names_real_tasks_and_keeps_the_valuable_ones():
    ids = {t.task_id for t in catalog.TASKS}
    assert set(catalog.POLICY_EXCLUDED) <= ids
    kept = {t.task_id for t in catalog.publishable()}
    assert not kept & set(catalog.POLICY_EXCLUDED)
    assert {"python-distutils-312", "pip-pep668-ubuntu", "node-openssl-md4", "git-safe-directory"} <= kept
    assert not kept & {"python-division-by-zero", "python-syntax-error", "rust-type-mismatch", "docker-exec-format"}
    assert all(reason for reason in catalog.POLICY_EXCLUDED.values())


def test_container_paths_are_left_alone_because_they_are_not_private():
    out = factory.clean({"command": "mkdir -p /tmp/app && cd /tmp/app && ./run.sh", "approach": "chmod +x /tmp/app/run.sh"})
    assert out["command"] == "mkdir -p /tmp/app && cd /tmp/app && ./run.sh"
    assert "<path>" not in json.dumps(out)


def test_what_belongs_to_the_host_is_replaced():
    assert factory.clean(f"error in {factory.ROOT}/tools/x.py") == "error in <project>/tools/x.py"
    if factory.HOST_USER:
        assert factory.clean(f"{factory.Path.home()}/x") == "<home>/x"
        assert factory.clean(f"/mnt/{factory.HOST_USER}/x") == "/mnt/<user>/x"
        assert factory.clean(f"{factory.HOST_USER}@laptop") == "<user>@laptop"
        # The bare word is not a path or an address: a user called "ubuntu" must not rewrite "ubuntu:24.04".
        assert factory.clean(f"image {factory.HOST_USER}:24.04") == f"image {factory.HOST_USER}:24.04"


def test_the_error_line_is_the_one_that_names_the_error():
    logs = "Traceback (most recent call last):\n  File x\nModuleNotFoundError: No module named 'yaml'\n"
    assert factory.error_line(logs, "ModuleNotFoundError") == "ModuleNotFoundError: No module named 'yaml'"
    assert factory.error_line("first line\nsecond", "Nothing") == "first line"
    assert factory.error_line("", "Nothing") == ""


def test_a_good_trail_passes_and_gets_a_fingerprint():
    c = candidate()
    factory.validate(c)
    assert c["fingerprint"].startswith("fp2_")


def test_a_trail_nobody_could_find_or_use_is_refused():
    for message in ("EACCES", "fatal error", ""):
        c = candidate()
        c["problem"]["error_message"] = message
        c["problem"]["error_type"] = message or "EACCES"
        with pytest.raises(ValueError, match="too short"):
            factory.validate(c)
    c = candidate()
    c["solution"]["shell_commands_executed"][0]["command"] = "<path>"
    with pytest.raises(ValueError, match="placeholder"):
        factory.validate(c)


def test_a_trail_without_a_real_failure_or_fix_is_refused():
    c = candidate()
    c["_factory"]["fixed"]["exit_code"] = 1
    with pytest.raises(ValueError):
        factory.validate(c)
    c = candidate()
    c["_factory"]["failed"][0]["exit_code"] = 0
    with pytest.raises(ValueError):
        factory.validate(c)


def feed_item(task_fp, trail_id, model="seed-factory", **problem):
    trail = copy.deepcopy(EXAMPLE)
    trail["agent_info"]["model"] = model
    trail["problem"].update(problem)
    return {"trail_id": trail_id, "fingerprint": task_fp, "trail": trail}


def test_retire_picks_policy_excluded_and_flawed_factory_trails_only():
    items = [
        feed_item("fp2_a", "1", error_message="ZeroDivisionError: division by zero"),
        feed_item("fp2_b", "2", error_message="ModuleNotFoundError: No module named 'distutils'"),
        feed_item("fp2_c", "3", model="claude-opus-5-5", error_message="ZeroDivisionError: division by zero"),
        feed_item("fp2_d", "4", error_message="EACCES"),
    ]
    by_fp = {"fp2_a": "python-division-by-zero", "fp2_b": "python-distutils-312"}
    chosen = retire.select(items, by_fp, include_flawed=False)
    assert [c[0] for c in chosen] == ["1"], "only the excluded task; others' trails are never touched"
    chosen = retire.select(items, by_fp, include_flawed=True)
    assert [c[0] for c in chosen] == ["1", "4"], "a factory trail with a useless message goes with --flawed"


def test_retire_refuses_other_endpoints_and_hosts():
    with pytest.raises(RuntimeError):
        retire.call("https://myrmo.dev", "GET", "/v1/analytics")
    with pytest.raises(RuntimeError):
        retire.call("https://myrmo.dev", "DELETE", "/v1/trails/not-a-uuid")


def test_the_colony_decides_whether_a_trail_is_already_there(monkeypatch):
    def found(base, method, path, body=None):
        return 200, {}

    def missing(base, method, path, body=None):
        raise urllib.error.HTTPError("u", 404, "nf", {}, None)

    monkeypatch.setattr(publisher, "request", found)
    assert publisher.exists_on_server("https://myrmo.dev", "fp2_x")
    monkeypatch.setattr(publisher, "request", missing)
    assert not publisher.exists_on_server("https://myrmo.dev", "fp2_x")


def test_docker_download_chatter_is_not_the_tasks_output():
    noisy = (
        "Unable to find image 'ubuntu:24.04' locally\n24.04: Pulling from library/ubuntu\n2d8d3a1cd5f4: Pull complete\n"
        "Digest: sha256:abc\nStatus: Downloaded newer image for ubuntu:24.04\n"
        "fatal: detected dubious ownership in repository at '/tmp/repo'\n"
    )
    assert factory.strip_noise(noisy) == "fatal: detected dubious ownership in repository at '/tmp/repo'"
    assert factory.error_line(factory.strip_noise(noisy), "git dubious ownership").startswith("fatal: detected dubious ownership")


def test_a_preferred_message_is_used_only_if_the_container_printed_it():
    logs = "node: boom\nError: error:0308010C:digital envelope routines::unsupported\n  code: 'ERR_OSSL_EVP_UNSUPPORTED'\n"
    wanted = catalog.MESSAGE_OVERRIDES["node-openssl-md4"]
    assert factory.error_line(logs, "ERR_OSSL_EVP_UNSUPPORTED", wanted) == wanted
    assert factory.error_line("something else", "ERR_OSSL_EVP_UNSUPPORTED", wanted) == "something else"


def test_the_evidence_is_what_the_verification_printed():
    fixed = {"stdout": "Setting up libfoo ...\nlots of install output\n" + factory.VERIFY_MARK + "\nhash ok\n", "stderr": ""}
    assert factory.verification_evidence(fixed) == "hash ok"
    assert factory.verification_evidence({"stdout": "", "stderr": ""}) == "exit code 0, no output"


def test_a_failed_setup_is_never_mistaken_for_the_failure_a_task_shows(monkeypatch):
    class Done:
        returncode = factory.SETUP_FAILED
        stdout = ""
        stderr = "seed-factory: setup failed"

    monkeypatch.setattr(factory.subprocess, "run", lambda *a, **k: Done())
    task = next(t for t in catalog.TASKS if t.setup)
    with pytest.raises(factory.SetupFailed):
        factory.run(task, "false")


def test_a_matching_line_is_returned_whole():
    logs = "debconf: delaying package configuration\nfatal: detected dubious ownership in repository at '/tmp/repo'\n"
    line = factory.error_line(logs, "git dubious ownership", catalog.MESSAGE_OVERRIDES["git-safe-directory"])
    assert line == "fatal: detected dubious ownership in repository at '/tmp/repo'"


# -- provenance ---------------------------------------------------------------------------


def test_licences_the_project_can_pass_on():
    # The strings are the ones SetupBench puts in its `license_spdx` field.
    for ok in ("MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "BSD-3-Clause AND MIT", "BSD-2-Clause OR Apache-2.0", "GPL-2.0-only OR MIT", "(MIT OR GPL-3.0) AND Apache-2.0", "mit"):
        assert provenance.licence_allowed(ok), ok
    for refused in ("AGPL-3.0", "GPL-2.0-only", "MPL-2.0", "MIT AND GPL-3.0", "(GPL-3.0 OR MPL-2.0) AND MIT", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0",
                    "NOASSERTION", "", None, "MIT AND", "(MIT", "MIT)", "Apache-2.0 WITH LLVM-exception", "Apache-2.0+"):
        assert not provenance.licence_allowed(refused), refused


def test_a_trail_without_provenance_is_refused():
    c = candidate()
    del c["_provenance"]
    with pytest.raises(ValueError, match="no provenance record"):
        factory.validate(c)
    c = candidate()
    del c["_provenance"]["content_sha256"]
    with pytest.raises(ValueError, match="content_sha256"):
        factory.validate(c)


def test_a_source_must_be_permissive_and_never_copied():
    ok = {"kind": "repository", "ref": "https://github.com/microsoft/SetupBench", "licence": "MIT", "used_as": "environment"}
    assert provenance.check(provenance_for(candidate(), sources=[ok])) == []
    copyleft = {**ok, "ref": "https://example.test/gpl-project", "licence": "GPL-2.0-only"}
    assert "not one the project can pass on" in provenance.check(provenance_for(candidate(), sources=[ok, copyleft]))[0]
    sharealike = {"kind": "document", "ref": "https://stackoverflow.com/q/1", "licence": "CC-BY-SA-4.0", "used_as": "discovery"}
    assert provenance.check(provenance_for(candidate(), sources=[sharealike]))
    copied = {**ok, "used_as": "copied-text"}
    assert "never copied text or code" in provenance.check(provenance_for(candidate(), sources=[copied]))[0]
    unlicensed = {**ok, "licence": None}
    assert provenance.check(provenance_for(candidate(), sources=[unlicensed]))


def test_a_model_needs_a_licence_the_project_can_pass_on_or_reviewed_terms():
    assert provenance.check(provenance_for(candidate(), model="qwen3-coder", model_licence="Apache-2.0")) == []
    assert provenance.check(provenance_for(candidate(), model="some-api-model", model_terms_reviewed=True)) == []
    problems = provenance.check(provenance_for(candidate(), model="some-api-model"))
    assert problems and "terms were not reviewed" in problems[0]
    assert provenance.check(provenance_for(candidate(), model="llama-like", model_licence="Llama-Community"))
    # The owner can accept a model's terms for this use, by name and date; a vague or dateless claim does not count.
    assert provenance.check(provenance_for(candidate(), model="some-api-model", model_terms_accepted_by="the project owner, 2026-10-08")) == []
    assert provenance.check(provenance_for(candidate(), model="some-api-model", model_terms_accepted_by="yes"))


def test_the_publisher_sends_protocol_v1_only_and_notices_a_trail_that_changed():
    c = candidate()
    c["fingerprint"] = "fp2_0000000000000000"
    sent = publisher.payload(c)
    assert "_factory" not in sent and "_provenance" not in sent and "fingerprint" not in sent
    assert publisher.provenance_problems(c) == []
    c["problem"]["error_message"] += " (edited by hand)"
    assert publisher.provenance_problems(c) == ["the trail changed after its provenance was recorded"]
    del c["_provenance"]
    assert publisher.provenance_problems(c) == ["no provenance record"]


def test_the_record_keeps_what_is_needed_to_audit_a_trail_later():
    rec = candidate()["_provenance"]
    assert rec["origin"] == "seed-factory" and rec["authored_by"] == "project"
    assert rec["generated_by"] == {"kind": "scripted-commands", "model": None, "model_licence": None, "model_terms_reviewed": False, "model_terms_accepted_by": None}
    assert rec["image"] == {"ref": "python:3.12.4", "digest": "python@sha256:" + "a" * 64}
    assert rec["tool"] == {"commit": "abc123", "dirty": False}
    assert len(rec["content_sha256"]) == 64 and rec["sources"] == []


def test_the_publisher_keeps_a_ledger_and_sends_nothing_without_provenance(monkeypatch, tmp_path):
    good, bare = candidate(), candidate()
    good["fingerprint"], bare["fingerprint"] = "fp2_aaaaaaaaaaaaaaaa", "fp2_bbbbbbbbbbbbbbbb"
    bare["problem"]["error_message"] = "ModuleNotFoundError: No module named 'other_thing'"
    del bare["_provenance"]
    source = tmp_path / "lot.jsonl"
    source.write_text("\n".join(json.dumps(t) for t in (good, bare)) + "\n", encoding="utf-8")
    sent = []

    def fake(base, method, path, body=None):
        if method == "GET" and "by-fingerprint" in path:
            raise urllib.error.HTTPError("u", 404, "nf", {}, None)
        if method == "POST":
            sent.append(body)
            return 202, {"trail_id": "11111111-1111-4111-8111-111111111111"}
        return 200, {"status": "indexed", "reasons": []}

    monkeypatch.setattr(publisher, "request", fake)
    monkeypatch.setattr(publisher, "OUT", tmp_path)
    monkeypatch.setattr(publisher.time, "sleep", lambda s: None)
    monkeypatch.setattr("sys.argv", ["publisher", "--base", "http://localhost:8080", "--input", str(source), "--max", "5"])
    assert publisher.main() == 0
    assert len(sent) == 1 and "_provenance" not in sent[0], "only the trail with provenance went out, and without its bookkeeping"
    ledger = [json.loads(line) for line in (tmp_path / "provenance.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(ledger) == 1
    assert ledger[0]["trail_id"] == "11111111-1111-4111-8111-111111111111" and ledger[0]["status"] == "indexed"
    assert ledger[0]["provenance"]["content_sha256"] == good["_provenance"]["content_sha256"]


def test_no_task_comes_from_the_reserved_half_of_the_coverage_set():
    lines = {json.loads(l)["id"]: json.loads(l) for l in (ROOT.parents[1] / "bench/coverage/lines.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}
    from_probes = [t for t in catalog.TASKS if t.probe]
    assert len(from_probes) >= 30
    assert all(lines[t.probe]["split"] == "candidate" for t in from_probes)
    assert {l["split"] for l in lines.values()} == {"candidate", "reserved"}


def test_a_reserved_line_refuses_to_become_a_task():
    from catalog import probes

    reserved = next(i for i, l in probes._lines().items() if l["split"] == "reserved")
    with pytest.raises(ValueError, match="reserved"):
        probes.from_probe(reserved, category="other", error_type="x", summary="s", context="c", failed_approaches=(), fix="true", verify="true", root_cause="r", steps=(), tags=(), runtime={})


def test_tasks_written_by_a_model_name_it_and_the_owner_who_accepted_its_terms():
    mine = [t for t in catalog.TASKS if t.written_by_model]
    assert mine and all(t.ecosystem for t in mine)
    rec = provenance_for(candidate(), model=mine[0].written_by_model, model_terms_accepted_by=factory.OWNER_ACCEPTANCE)
    assert provenance.check(rec) == [] and rec["generated_by"]["kind"] == "model"
