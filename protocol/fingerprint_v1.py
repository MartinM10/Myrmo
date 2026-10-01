"""Reference implementation of the Myrmo error fingerprint, version 1.

The fingerprint identifies "the same error" across machines, so that a repeat error can be
answered by one cacheable GET (/v1/trails/by-fingerprint/{fp}) instead of a semantic search.
Every client and the server MUST produce identical output for the vectors in
fingerprint.v1.vectors.json.

    python fingerprint_v1.py            # verify the vectors
    python fingerprint_v1.py --write    # regenerate them (only when the spec changes)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

VERSION_PREFIX = "fp1_"
MAX_NORMALIZED_LENGTH = 300
SEPARATOR = "\x1f"  # ASCII unit separator; cannot appear in normalized text

# Applied in order. Order matters: URLs before paths, UUIDs before generic hex.
_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s'\"<>]+"), "<url>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<uuid>"),
    (re.compile(r"\b0x[0-9a-f]+\b"), "<hex>"),
    (re.compile(r"\b[0-9a-f]{12,}\b"), "<hex>"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"), "<ip>"),
    (re.compile(r"\b[a-z]:\\[^\s'\"]+"), "<path>"),
    (re.compile(r"(?<![\w.<>])(?:~|\.{1,2})?/(?:[^\s'\"/:]+/)*[^\s'\"/:]*"), "<path>"),
    (re.compile(r"(?<![\w<>/])[\w.\-]+(?:/[\w.\-]+)+"), "<path>"),
    (re.compile(r"\b(?=[a-z_]*\d)(?=[0-9_]*[a-z])\w{12,}\b"), "<id>"),
    (re.compile(r"\bline \d+"), "line <n>"),
    (re.compile(r":\d+(?::\d+)?\b"), ":<n>"),
    (re.compile(r"\b\d{4,}\b"), "<n>"),
]


def normalize_message(error_type: str, message: str) -> str:
    """Strip everything that varies between machines but not between errors."""
    text = unicodedata.normalize("NFKC", message).lower().strip()
    prefix = unicodedata.normalize("NFKC", error_type).lower().strip() + ":"
    if text.startswith(prefix):
        text = text[len(prefix):]
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_NORMALIZED_LENGTH]


def fingerprint(runtime: str, error_type: str, message: str) -> str:
    """Return the fp1 fingerprint for an error.

    runtime:    environment.runtime.name (e.g. "python", "node")
    error_type: problem.error_type
    message:    problem.error_message; if absent, the first line of raw_logs that contains
                error_type, else the first non-empty line of raw_logs.
    """
    material = SEPARATOR.join([
        runtime.strip().lower(),
        unicodedata.normalize("NFKC", error_type).strip().lower(),
        normalize_message(error_type, message),
    ])
    return VERSION_PREFIX + hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


# Inputs whose fingerprints are pinned. Pairs that must collide are listed together.
_VECTOR_INPUTS = [
    ("python", "ModuleNotFoundError", "ModuleNotFoundError: No module named 'distutils'"),
    ("python", "ModuleNotFoundError", "ModuleNotFoundError:   No module named 'distutils'  "),
    ("python", "ModuleNotFoundError", "No module named 'numpy'"),
    ("node", "ERR_OSSL_EVP_UNSUPPORTED", "Error: error:0308010C:digital envelope routines::unsupported"),
    ("python", "RuntimeError", "RuntimeError: CUDA error: no kernel image is available for execution on the device"),
    ("node", "git fatal", "fatal: detected dubious ownership in repository at '/__w/app/app'"),
    ("node", "git fatal", "fatal: detected dubious ownership in repository at '/home/runner/work/x/x'"),
    ("python", "OSError", "OSError: [Errno 98] Address already in use: ('10.0.0.12', 8080)"),
    ("python", "OSError", "OSError: [Errno 98] Address already in use: ('192.168.1.5', 8080)"),
    ("python", "FileNotFoundError", "FileNotFoundError: [Errno 2] No such file or directory: 'C:\\Users\\ana\\proj\\cfg.yaml'"),
    ("python", "FileNotFoundError", "FileNotFoundError: [Errno 2] No such file or directory: '/home/bob/proj/cfg.yaml'"),
    ("rust", "E0502", "error[E0502]: cannot borrow `*self` as mutable because it is also borrowed as immutable --> src/lib.rs:42:9"),
    ("rust", "E0502", "error[E0502]: cannot borrow `*self` as mutable because it is also borrowed as immutable --> src/main.rs:7:13"),
    ("python", "HTTP 429", "anthropic.RateLimitError: Error code: 429 - request req_011CXk2v9mYwq7Zt3 failed"),
    ("python", "HTTP 429", "anthropic.RateLimitError: Error code: 429 - request req_7Hq2LmN9xPw4Kd81 failed"),
    ("node", "Error", "Error: connect ECONNREFUSED 127.0.0.1:5432 (request 3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b)"),
]


def _vectors() -> list[dict[str, str]]:
    return [
        {
            "runtime": rt,
            "error_type": et,
            "message": msg,
            "normalized": normalize_message(et, msg),
            "fingerprint": fingerprint(rt, et, msg),
        }
        for rt, et, msg in _VECTOR_INPUTS
    ]


def main() -> int:
    path = Path(__file__).with_name("fingerprint.v1.vectors.json")
    vectors = _vectors()
    if "--write" in sys.argv:
        path.write_text(json.dumps(vectors, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {len(vectors)} vectors to {path.name}")
        return 0
    expected = json.loads(path.read_text(encoding="utf-8"))
    failures = [
        (e["message"], e["fingerprint"], fingerprint(e["runtime"], e["error_type"], e["message"]))
        for e in expected
        if fingerprint(e["runtime"], e["error_type"], e["message"]) != e["fingerprint"]
    ]
    for message, want, got in failures:
        print(f"FAIL {message!r}: expected {want}, got {got}")
    print(f"{len(expected) - len(failures)}/{len(expected)} vectors pass")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
