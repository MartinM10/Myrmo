import json
from pathlib import Path

from myrmo import fingerprint, guess_error_type, normalize_message, redact_text, redact_value

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "protocol/fingerprint.v1.vectors.json").read_text(encoding="utf-8"))


def test_matches_every_normative_fingerprint_vector():
    assert len(VECTORS) >= 16
    for v in VECTORS:
        assert normalize_message(v["error_type"], v["message"]) == v["normalized"]
        assert fingerprint(v["runtime"], v["error_type"], v["message"]) == v["fingerprint"]


def test_guesses_error_type():
    assert guess_error_type("ModuleNotFoundError: No module named 'x'") == "ModuleNotFoundError"
    assert guess_error_type("Something went wrong: details") == ""
    assert guess_error_type("no colon") == ""


def test_removes_secrets():
    assert "sk-ant-api03" not in redact_text("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123")
    assert redact_text("AKIAIOSFODNN7EXAMPLE used") == "<redacted:aws_access_key> used"
    assert redact_text("postgres://admin:hunter2@db.internal:5432/app") == "postgres://<redacted:connection_string>@db.internal:5432/app"
    assert redact_text("password=SuperSecret123 next") == "password=<redacted:secret> next"
    assert redact_text("Authorization: Bearer abcdefghijklmnop1234567890") == "Authorization: Bearer <redacted:token>"
    assert redact_text("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----") == "<redacted:private_key>"


def test_removes_personal_data_and_keeps_harmless_values():
    assert redact_text("mail ana.garcia@acme.com now") == "mail <redacted:email> now"
    assert redact_text("git@github.com:org/repo.git") == "git@github.com:org/repo.git"
    assert redact_text("connect 10.0.3.17:5432") == "connect <redacted:ip>:5432"
    assert redact_text("listen 127.0.0.1:8080") == "listen 127.0.0.1:8080"
    assert redact_text("version 10.0.26100.1") == "version 10.0.26100.1"
    assert redact_text('File "/home/martin/app/x.py"') == 'File "/home/<user>/app/x.py"'
    assert redact_text(r"C:\Users\ana\proj\cfg.yaml") == r"C:\Users\<user>\proj\cfg.yaml"


def test_redaction_is_nested_counted_and_idempotent():
    report = {}
    once = redact_value({"a": ["api_key=abcd1234efgh", {"b": "ok"}]}, report)
    assert redact_value(once) == once
    assert once["a"][1]["b"] == "ok"
    assert report == {"password_assignment": 1}
