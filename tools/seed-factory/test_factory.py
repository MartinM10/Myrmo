import copy
import importlib.util
import json
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
catalog = load("catalog")
EXAMPLE = json.loads((ROOT.parents[1] / "protocol/examples/trail.distutils.json").read_text(encoding="utf-8"))


def candidate():
    """A schema-valid trail shaped like the factory's output."""
    c = copy.deepcopy(EXAMPLE)
    c["problem"]["error_message"] = "ModuleNotFoundError: No module named 'distutils'"
    c["effort"]["failed_attempts"] = 2
    c["_factory"] = {"task_id": "t", "failed": [{"exit_code": 1}, {"exit_code": 1}], "fixed": {"exit_code": 0}}
    return c


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
    assert c["fingerprint"].startswith("fp1_")


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
        feed_item("fp1_a", "1", error_message="ZeroDivisionError: division by zero"),
        feed_item("fp1_b", "2", error_message="ModuleNotFoundError: No module named 'distutils'"),
        feed_item("fp1_c", "3", model="claude-opus-5-5", error_message="ZeroDivisionError: division by zero"),
        feed_item("fp1_d", "4", error_message="EACCES"),
    ]
    by_fp = {"fp1_a": "python-division-by-zero", "fp1_b": "python-distutils-312"}
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
    assert publisher.exists_on_server("https://myrmo.dev", "fp1_x")
    monkeypatch.setattr(publisher, "request", missing)
    assert not publisher.exists_on_server("https://myrmo.dev", "fp1_x")


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
