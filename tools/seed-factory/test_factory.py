import importlib.util
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("factory", ROOT / "factory.py")
factory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(factory)
publisher_spec = importlib.util.spec_from_file_location("publisher", ROOT / "publisher.py")
publisher = importlib.util.module_from_spec(publisher_spec)
publisher_spec.loader.exec_module(publisher)


def test_url_guard():
    assert publisher.allowed("http://localhost:8080")
    assert publisher.allowed("https://myrmo.dev")
    assert publisher.allowed("http://10.0.0.8:8080")
    assert publisher.allowed("https://[fd00::8]:8080")
    assert not publisher.allowed("https://example.com")
    assert not publisher.allowed("http://myrmo.dev")


def test_every_catalog_task_has_failed_and_fix():
    assert len(factory.TASKS) >= 10
    for task in factory.TASKS:
        assert task.failing_command and task.failed_approaches and task.fix_command and task.verification_command
