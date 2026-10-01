"""Client-side redaction: the same detectors the colony runs, applied before anything
leaves the machine. Keep in sync with server/src/redact.rs."""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

Report = Dict[str, int]
Replacer = Callable[[re.Match], Optional[str]]


def _full(kind: str) -> str:
    return f"<redacted:{kind}>"


def _ip(m: re.Match) -> Optional[str]:
    ip = m.group(0)
    valid = all(int(octet) <= 255 for octet in ip.split("."))
    harmless = ip in ("127.0.0.1", "0.0.0.0", "255.255.255.255")
    return _full("ip") if valid and not harmless else None


_RULES: List[Tuple[str, re.Pattern, Replacer]] = [
    (kind, re.compile(pattern, flags), replace)
    for kind, pattern, flags, replace in [
        ("private_key", r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S, lambda m: _full("private_key")),
        ("api_key", r"\bsk-ant-[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bglpat-[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bAIza[0-9A-Za-z_\-]{35}", 0, lambda m: _full("api_key")),
        ("api_key", r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}", 0, lambda m: _full("api_key")),
        ("aws_access_key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0, lambda m: _full("aws_access_key")),
        ("aws_access_key", r"(aws_secret_access_key\s*[=:]\s*['\"]?)[A-Za-z0-9/+=]{40}", re.I, lambda m: m.group(1) + _full("aws_access_key")),
        ("jwt", r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", 0, lambda m: _full("jwt")),
        ("token", r"\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*", re.I, lambda m: m.group(1) + _full("token")),
        ("connection_string", r"\b([a-z][a-z0-9+.\-]*://)[^:/\s@<>]+:[^@\s/<>]+@", re.I, lambda m: m.group(1) + _full("connection_string") + "@"),
        (
            "password_assignment",
            r"\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[=:]\s*)(['\"]?)[^\s'\",;<>]{4,}",
            re.I,
            lambda m: m.group(1) + m.group(2) + m.group(3) + _full("secret"),
        ),
        ("email", r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", 0, lambda m: None if m.group(0).startswith("git@") else _full("email")),
        ("ip", r"\b(?:\d{1,3}\.){3}\d{1,3}\b", 0, _ip),
        ("phone", r"\+\d{1,3}[\s.\-]?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b", 0, lambda m: _full("phone")),
        ("home_path", r"(/home/|/Users/)[^/\s'\"<>]+", 0, lambda m: m.group(1) + "<user>"),
        ("home_path", r"([a-z]:\\Users\\)[^\\\s'\"<>]+", re.I, lambda m: m.group(1) + "<user>"),
    ]
]


def redact_text(text: str, report: Optional[Report] = None) -> str:
    """Replace secrets and personal data in `text`, counting each kind in `report`."""
    report = {} if report is None else report
    for kind, pattern, replace in _RULES:
        if not pattern.search(text):
            continue
        hits = 0

        def sub(m: re.Match) -> str:
            nonlocal hits
            out = replace(m)
            if out is None:
                return m.group(0)
            hits += 1
            return out

        text = pattern.sub(sub, text)
        if hits:
            report[kind] = report.get(kind, 0) + hits
    return text


def redact_value(value: Any, report: Optional[Report] = None) -> Any:
    """Deep copy of `value` with every string redacted."""
    report = {} if report is None else report
    if isinstance(value, str):
        return redact_text(value, report)
    if isinstance(value, list):
        return [redact_value(v, report) for v in value]
    if isinstance(value, dict):
        return {k: redact_value(v, report) for k, v in value.items()}
    return value
