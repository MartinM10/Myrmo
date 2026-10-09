import json
from pathlib import Path

from myrmo import fingerprint, fingerprint2, guess_error_type, normalize_message, normalize_message2, redact_text, redact_value

REDACTION_VECTORS = json.loads((Path(__file__).resolve().parents[3] / "protocol/redact.v1.vectors.json").read_text(encoding="utf-8"))
VECTORS = json.loads((Path(__file__).resolve().parents[3] / "protocol/fingerprint.v1.vectors.json").read_text(encoding="utf-8"))
VECTORS_2 = json.loads((Path(__file__).resolve().parents[3] / "protocol/fingerprint.v2.vectors.json").read_text(encoding="utf-8"))


def test_matches_every_normative_fingerprint_vector():
    assert len(VECTORS) >= 16
    for v in VECTORS:
        assert normalize_message(v["error_type"], v["message"]) == v["normalized"]
        assert fingerprint(v["runtime"], v["error_type"], v["message"]) == v["fingerprint"]


def test_matches_every_normative_fp2_vector():
    assert len(VECTORS_2) >= 40
    for v in VECTORS_2:
        assert normalize_message2(v["message"]) == v["normalized"]
        assert fingerprint2(v["message"]) == v["fingerprint"]


def test_fp2_needs_the_message_and_nothing_else():
    # What a searcher holds is the line; the runtime and the declared type are not part of the key.
    assert fingerprint2("java.util.concurrent.CompletionException: java.lang.IllegalStateException: Recursive update") == fingerprint2("IllegalStateException: Recursive update")
    assert fingerprint2("No module named 'numpy'") != fingerprint2("No module named 'scipy'")
    assert fingerprint2("bash: uv: command not found") != fingerprint2("bash: node: command not found")


def test_guesses_error_type():
    assert guess_error_type("ModuleNotFoundError: No module named 'x'") == "ModuleNotFoundError"
    assert guess_error_type("Something went wrong: details") == ""
    assert guess_error_type("no colon") == ""


def test_removes_secrets():
    assert "sk-ant-api03" not in redact_text("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123")
    assert redact_text("AKIAIOSFODNN7EXAMPLE used") == "<redacted:aws_access_key> used"
    assert redact_text("postgres://admin:hunter2@db.internal:5432/app") == "postgres://<redacted:connection_string>@<redacted:hostname>:5432/app"
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


def test_matches_every_normative_redaction_vector():
    assert len(REDACTION_VECTORS) >= 100
    for v in REDACTION_VECTORS:
        kinds = {}
        out = redact_text(v["input"], kinds)
        assert out == v["output"], v["input"]
        assert dict(sorted(kinds.items())) == v["kinds"], v["input"]
        assert redact_text(out) == out, f"not idempotent: {v['input']!r}"


def test_long_hostile_input_is_redacted_in_bounded_time():
    # Unbounded prefixes made these quadratic: 16,000 characters took twenty seconds.
    import time

    for text in ["a." * 8000, "://" + "a." * 8000, "word." * 3000 + "token=x", "a@" * 8000]:
        start = time.perf_counter()
        redact_text(text)
        assert time.perf_counter() - start < 3, text[:20]


NAME_VECTORS = json.loads((Path(__file__).resolve().parents[3] / "protocol/placeholder_names.v1.vectors.json").read_text(encoding="utf-8"))


def test_matches_every_normative_placeholder_name_vector():
    from myrmo.names import names_conflict, placeholder_names

    assert len(NAME_VECTORS["names"]) >= 10 and len(NAME_VECTORS["conflicts"]) >= 10
    for v in NAME_VECTORS["names"]:
        assert placeholder_names(v["text"]) == set(v["names"]), v["text"]
    for v in NAME_VECTORS["conflicts"]:
        assert names_conflict(v["query"], v["message"]) is v["conflict"], v["note"]
