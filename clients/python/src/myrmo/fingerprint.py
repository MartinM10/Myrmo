"""Myrmo error fingerprints. `fingerprint2` (fp2, the one the colony indexes) is copied from
protocol/fingerprint_v2.py and `fingerprint` (fp1, retired) from protocol/fingerprint_v1.py; CI checks both
against protocol/fingerprint.v2.vectors.json and protocol/fingerprint.v1.vectors.json.

fp2 hashes the error message alone, with the labels that wrap an error line dropped, because a searcher knows
the line it holds and nothing reliable about the error type a trail's author declared. fp1 also hashed the
runtime and the error type and is kept only for old trails and tests.

Notes of the first version:

The fingerprint identifies "the same error" across machines, so that a repeat error can be
answered by one cacheable GET (/v1/trails/by-fingerprint/{fp}) instead of a semantic search.
Every client and the server MUST produce identical output for the vectors in
fingerprint.v1.vectors.json.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

VERSION_PREFIX = "fp1_"
VERSION_PREFIX_2 = "fp2_"
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


# Labels removed from the start of the message, one after another, at most MAX_LABELS of them. They are matched on the
# text as written (before lowercasing): the capital letter is what tells a class name from a word.
MAX_LABELS = 4
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


def normalize_message2(message: str) -> str:
    """Strip everything that varies between machines or between wrappers, but not between errors."""
    text = strip_labels(unicodedata.normalize("NFKC", message).strip()).lower()
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_NORMALIZED_LENGTH]


def fingerprint2(message: str) -> str:
    """Return the fp2 fingerprint for an error: the key the colony files a trail under, computed from its message.

    message: the error line the caller holds (a trail's `problem.error_message`)."""
    return VERSION_PREFIX_2 + hashlib.sha256(normalize_message2(message).encode("utf-8")).hexdigest()[:16]


def fingerprint(runtime: str, error_type: str, message: str) -> str:
    """Return the fp1 fingerprint for an error. Retired: the colony no longer indexes it, use `fingerprint2`.

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


def guess_error_type(error_line: str) -> str:
    """`Type: message` -> `Type`, for callers that only have the error line."""
    head, sep, _ = error_line.partition(":")
    head = head.strip()
    return head if sep and head and len(head) <= 64 and " " not in head else ""
