"""Reference implementation of the Myrmo error fingerprint, version 2.

fp1 hashed the runtime, the error type and the message. The error type is what a trail's author declared and a
searcher can only guess from the error line, so the two rarely agreed: on the trails agents wrote in production,
the key computed from the exact message matched the trail's own in 4 of 23 cases. fp2 hashes the message alone:
everything a searcher can know about the error is in the line it holds, so a repeat of the error computes the
key the trail was filed under.

    fp2 = "fp2_" + hex(sha256(normalize(message)))[0:16]

`normalize` first drops the labels that wrap an error line (the exception class, a severity word, a tool's error
code), then applies the same normalisation as fp1. Dropping them is what lets `java.util.concurrent.CompletionException:
java.lang.IllegalStateException: Recursive update` and `IllegalStateException: Recursive update` meet.

Every client and the server MUST produce identical output for the vectors in fingerprint.v2.vectors.json.

    python fingerprint_v2.py            # verify the vectors
    python fingerprint_v2.py --write    # regenerate them (only when the spec changes)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fingerprint_v1 import _RULES, MAX_NORMALIZED_LENGTH  # noqa: E402  (the volatile-token rules are shared)

VERSION_PREFIX = "fp2_"
#: Labels removed from the start of the message, one after another, at most this many.
MAX_LABELS = 4

# A label is what a tool puts in front of its message, followed by a colon and a space. They are matched on the text as
# written (before lowercasing), because the capital letter is what tells a class name from a word.
_CLASS = r"(?:[A-Za-z_][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*(?:Error|Exception|Warning|Failure)"
_SEVERITY = (
    r"(?:Error|ERROR|error|Fatal|FATAL|fatal|Warning|WARNING|warning|Panic|PANIC|panic|Exception|EXCEPTION|exception|Err|ERR|Caused by)"
    r"(?:\[[A-Za-z0-9_]+\])?"
)
_TOOL_CODE = r"(?:error|warning)\s+[A-Z]{1,5}[0-9]{2,5}"  # "error TS2322", "warning CS0168"
_LABEL = re.compile(rf"^(?:(?:Uncaught\s+)?(?:{_CLASS}|{_SEVERITY}|{_TOOL_CODE})\s*:\s+|npm\s+(?:ERR!|error)\s+)")


def strip_labels(message: str) -> str:
    """Drop the leading exception classes, severity words and tool codes of an error line."""
    for _ in range(MAX_LABELS):
        shorter = _LABEL.sub("", message, count=1)
        if shorter == message:
            break
        message = shorter
    return message


def normalize_message(message: str) -> str:
    """Strip everything that varies between machines or between wrappers, but not between errors."""
    text = strip_labels(unicodedata.normalize("NFKC", message).strip()).lower()
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_NORMALIZED_LENGTH]


def fingerprint(message: str) -> str:
    """Return the fp2 fingerprint for an error.

    message: problem.error_message; if absent, the first line of raw_logs that contains error_type, else the
             first non-empty line of raw_logs. A searcher passes the error line it holds.
    """
    return VERSION_PREFIX + hashlib.sha256(normalize_message(message).encode("utf-8")).hexdigest()[:16]


# Inputs whose fingerprints are pinned, in groups: the messages of one group MUST give the same fingerprint, and those
# of different groups MUST differ. (group, note, message)
_VECTOR_INPUTS: list[tuple[str, str, str]] = [
    ("distutils", "the line as printed", "ModuleNotFoundError: No module named 'distutils'"),
    ("distutils", "without its class", "No module named 'distutils'"),
    ("distutils", "extra whitespace", "  ModuleNotFoundError:   No module named 'distutils'  "),
    ("distutils", "Uncaught before the class", "Uncaught ModuleNotFoundError: No module named 'distutils'"),
    ("numpy", "another module is another error", "ModuleNotFoundError: No module named 'numpy'"),
    ("recursive-update", "wrapped twice", "java.util.concurrent.CompletionException: java.lang.IllegalStateException: Recursive update"),
    ("recursive-update", "qualified class", "java.lang.IllegalStateException: Recursive update"),
    ("recursive-update", "simple class", "IllegalStateException: Recursive update"),
    ("recursive-update", "a cause line", "Caused by: java.lang.IllegalStateException: Recursive update"),
    ("recursive-update", "the message alone", "Recursive update"),
    ("npe", "qualified class", 'java.lang.NullPointerException: Cannot invoke "javax.sql.DataSource.getConnection()"'),
    ("npe", "simple class", 'NullPointerException: Cannot invoke "javax.sql.DataSource.getConnection()"'),
    ("e0502", "rustc, one file", "error[E0502]: cannot borrow `*self` as mutable because it is also borrowed as immutable --> src/lib.rs:42:9"),
    ("e0502", "rustc, another file", "error[E0502]: cannot borrow `*self` as mutable because it is also borrowed as immutable --> src/main.rs:7:13"),
    ("e0502", "without the error code", "cannot borrow `*self` as mutable because it is also borrowed as immutable --> src/main.rs:7:13"),
    ("ts2322", "tsc code", "error TS2322: Type 'string' is not assignable to type 'number'."),
    ("ts2322", "without the tool code", "Type 'string' is not assignable to type 'number'."),
    ("cannot-find-playwright", "node", "Error: Cannot find module 'playwright'"),
    ("cannot-find-playwright", "without Error", "Cannot find module 'playwright'"),
    ("cannot-find-express", "another module", "Error: Cannot find module 'express'"),
    ("pip-numpy", "pip", "ERROR: No matching distribution found for numpy==1.24.4"),
    ("pip-numpy", "without ERROR", "No matching distribution found for numpy==1.24.4"),
    ("npm-eresolve", "npm 9 and later", "npm error code ERESOLVE"),
    ("npm-eresolve", "npm 8 and earlier", "npm ERR! code ERESOLVE"),
    ("address-in-use", "one address", "OSError: [Errno 98] Address already in use: ('10.0.0.12', 8080)"),
    ("address-in-use", "another address", "OSError: [Errno 98] Address already in use: ('192.168.1.5', 8080)"),
    ("no-such-file", "windows path", "FileNotFoundError: [Errno 2] No such file or directory: 'C:\\Users\\ana\\proj\\cfg.yaml'"),
    ("no-such-file", "posix path", "FileNotFoundError: [Errno 2] No such file or directory: '/home/bob/proj/cfg.yaml'"),
    ("econnrefused", "one request id", "Error: connect ECONNREFUSED 127.0.0.1:5432 (request 3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b)"),
    ("econnrefused", "another request id", "Error: connect ECONNREFUSED 127.0.0.1:5432 (request 9d1c7a20-1b2c-4d3e-8f4a-5b6c7d8e9f01)"),
    ("rate-limit", "one request", "anthropic.RateLimitError: Error code: 429 - request req_011CXk2v9mYwq7Zt3 failed"),
    ("rate-limit", "another request", "anthropic.RateLimitError: Error code: 429 - request req_7Hq2LmN9xPw4Kd81 failed"),
    ("dubious-ownership", "one path", "fatal: detected dubious ownership in repository at '/home/runner/work/x/x'"),
    ("dubious-ownership", "another path", "fatal: detected dubious ownership in repository at '/__w/app/app'"),
    ("uv-not-found", "bash names the program, so the program stays", "bash: uv: command not found"),
    ("node-not-found", "another program is another error", "bash: node: command not found"),
    ("eacces", "a bare code", "EACCES"),
    ("eacces", "with a severity word", "Error: EACCES"),
    ("same-text", "different classes with the same text share a key, by design", "ValueError: invalid value for the setting"),
    ("same-text", "different classes with the same text share a key, by design", "TypeError: invalid value for the setting"),
    ("unicode", "NFKC folds full-width letters and colon", "Ｅｒｒｏｒ： boom went the thing"),
    ("unicode", "plain", "Error: boom went the thing"),
]


def _vectors() -> list[dict[str, str]]:
    return [
        {"group": group, "note": note, "message": msg, "normalized": normalize_message(msg), "fingerprint": fingerprint(msg)}
        for group, note, msg in _VECTOR_INPUTS
    ]


def _check_groups(vectors: list[dict[str, str]]) -> list[str]:
    """Messages of one group share a fingerprint, messages of different groups differ."""
    problems = []
    by_group: dict[str, set[str]] = {}
    for v in vectors:
        by_group.setdefault(v["group"], set()).add(v["fingerprint"])
    problems += [f"group {g!r} has {len(fps)} fingerprints" for g, fps in by_group.items() if len(fps) != 1]
    owners: dict[str, str] = {}
    for g, fps in by_group.items():
        for fp in fps:
            if owners.setdefault(fp, g) != g:
                problems.append(f"groups {owners[fp]!r} and {g!r} share {fp}")
    return problems


def main() -> int:
    path = Path(__file__).with_name("fingerprint.v2.vectors.json")
    vectors = _vectors()
    problems = _check_groups(vectors)
    if problems:
        print("\n".join(problems))
        return 1
    if "--write" in sys.argv:
        path.write_text(json.dumps(vectors, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {len(vectors)} vectors to {path.name}")
        return 0
    expected = json.loads(path.read_text(encoding="utf-8"))
    failures = [(e["message"], e["fingerprint"], fingerprint(e["message"])) for e in expected if fingerprint(e["message"]) != e["fingerprint"]]
    for message, want, got in failures:
        print(f"FAIL {message!r}: expected {want}, got {got}")
    problems = _check_groups(expected)
    for p in problems:
        print(f"FAIL {p}")
    print(f"{len(expected) - len(failures)}/{len(expected)} vectors pass")
    return 1 if failures or problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
