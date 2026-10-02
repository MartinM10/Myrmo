"""Client-side redaction: the same detectors the colony runs, applied before anything
leaves the machine. Keep in sync with server/src/redact.rs and
clients/typescript/packages/myrmo/src/redact.ts: all three must reproduce
protocol/redact.v1.vectors.json exactly.

Rules run in order, most specific first. A rule's replacement never matches a later rule (it
starts with `<`, which no value pattern accepts), so redacting twice changes nothing."""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

Report = Dict[str, int]
Replacer = Callable[[re.Match], Optional[str]]


def _full(kind: str) -> str:
    return f"<redacted:{kind}>"


# Values that are references or placeholders, not secrets. The test is narrow on purpose: a
# password may contain `(`, `$` or `/`, and leaking one costs far more than keeping a code
# fragment, so only unmistakable references are kept: `$DB_PASSWORD`, `${{ secrets.X }}`,
# `os.getenv(`, `get_secret()`, `None`, `****`, a URL, a path.
_LITERALS = {
    "none", "null", "nil", "true", "false", "undefined", "required", "optional", "string", "str",
    "int", "integer", "bool", "boolean", "empty", "redacted", "password", "secret", "token",
}
_ENV_REFERENCE = re.compile(r"^(?:\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$")
_CODE_REFERENCE = re.compile(r"^[A-Za-z_][\w.]*(?:\(\)|[(\[])$")


def _is_reference(value: str) -> bool:
    lower = value.lower()
    return (
        bool(_ENV_REFERENCE.match(value) or _CODE_REFERENCE.match(value))
        or value.startswith(("${", "{{", "[", "{"))
        or lower.startswith(("http://", "https://", "./", "../", "~/"))
        or (value.startswith("/") and "/" in value[1:])
        or lower in _LITERALS
        or set(value) <= set("*xX.#-_")
    )


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _ip(m: re.Match) -> Optional[str]:
    ip = m.group(0)
    valid = all(int(octet) <= 255 for octet in ip.split("."))
    harmless = ip in ("127.0.0.1", "0.0.0.0", "255.255.255.255")
    return _full("ip") if valid and not harmless else None


def _card(m: re.Match) -> Optional[str]:
    digits = re.sub(r"[^0-9]", "", m.group(0))
    return _full("card") if 13 <= len(digits) <= 19 and _luhn(digits) else None


def _keep_prefix(kind: str, value_group: int) -> Replacer:
    """`name = value` becomes `name = <redacted:kind>` unless the value is a reference."""

    def replace(m: re.Match) -> Optional[str]:
        if _is_reference(m.group(value_group)):
            return None
        return "".join(m.group(i) for i in range(1, value_group)) + _full(kind)

    return replace


def _authorization(m: re.Match) -> Optional[str]:
    scheme, value = m.group(2), m.group(3)
    if not scheme and value.lower() in ("bearer", "basic", "token", "digest", "negotiate", "ntlm", "hawk"):
        return None  # `Authorization: Bearer <redacted:token>`: the credential is already gone
    if _is_reference(value):
        return None
    return m.group(1) + scheme + _full("auth_header")


_NAMES_STRONG = (
    r"password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|"
    r"signing[_-]?key|encryption[_-]?key|access[_-]?token|auth[_-]?token"
)
_NAMES_WEAK = r"token|credentials?|session[_-]?id|sessionid|csrf|xsrf"
_CLI_NAMES = (
    r"password|passwd|pwd|pass|passphrase|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|"
    r"client[_-]?secret|private[_-]?key"
)

_RULES: List[Tuple[str, re.Pattern, Replacer]] = [
    (kind, re.compile(pattern, flags), replace)
    for kind, pattern, flags, replace in [
        # Private keys, whole or cut off by a truncated log.
        ("private_key", r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----", 0, lambda m: _full("private_key")),
        ("private_key", r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\\n|\r?\n)[A-Za-z0-9+/=]{16,})*", 0, lambda m: _full("private_key")),
        # Password hashes: bcrypt, argon2, crypt(3).
        ("password_hash", r"\$(?:2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}|argon2(?:id|i|d)\$[^\s'\x22<>]{20,}|[156y]\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{20,})", 0, lambda m: _full("password_hash")),
        # Provider tokens.
        ("api_key", r"\bsk-ant-[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bglpat-[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bAIza[0-9A-Za-z_\-]{35}", 0, lambda m: _full("api_key")),
        ("api_key", r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bnpm_[A-Za-z0-9]{36}\b", 0, lambda m: _full("api_key")),
        ("api_key", r"\bhf_[A-Za-z0-9]{30,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{40,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\bya29\.[A-Za-z0-9_\-]{20,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\b(?:dckr_pat_|dop_v1_|gsk_|xai-|r8_|lin_api_|pplx-|shp(?:at|ca|pa|ss)_|whsec_|sq0(?:atp|csp)-|glptt-|glrt-|GOCSPX-)[A-Za-z0-9_\-]{16,}", 0, lambda m: _full("api_key")),
        ("api_key", r"\b(?:dapi|SK)[0-9a-f]{32}\b|\bkey-[0-9a-f]{32}\b", 0, lambda m: _full("api_key")),
        ("api_key", r"\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{36,})\b", 0, lambda m: _full("api_key")),
        ("api_key", r"\b((?:account|sharedaccess)key\s*=)[A-Za-z0-9+/=]{20,}", re.I, lambda m: m.group(1) + _full("api_key")),
        ("aws_access_key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0, lambda m: _full("aws_access_key")),
        ("aws_access_key", r"(aws_secret_access_key\s*[=:]\s*['\x22]?)[A-Za-z0-9/+=]{40}", re.I, lambda m: m.group(1) + _full("aws_access_key")),
        ("webhook", r"https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}|https://(?:discord(?:app)?\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+|https://[a-z0-9.\-]*webhook\.office\.com/[^\s'\x22<>]+", re.I, lambda m: _full("webhook")),
        ("jwt", r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", 0, lambda m: _full("jwt")),
        ("token", r"\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*", re.I, lambda m: m.group(1) + _full("token")),
        # Headers.
        ("auth_header", r"\b((?:proxy-)?authorization['\x22]?[ \t]*[:=][ \t]*['\x22]?)((?:[A-Za-z][A-Za-z0-9_\-]*[ \t]+)?)([^\s'\x22,;<>]{6,})", re.I, _authorization),
        ("auth_header", r"\b((?:x-api-key|x-auth-token|x-access-token|x-amz-security-token|x-csrf-token|x-xsrf-token|x-goog-api-key|x-gitlab-token|x-github-token|private-token|api-key|apikey)['\x22]?[ \t]*[:=][ \t]*['\x22]?)([^\s'\x22,;<>]{4,})", re.I, _keep_prefix("auth_header", 2)),
        ("cookie", r"\b((?:set-)?cookie['\x22]?[ \t]*:[ \t]*['\x22]?)([^\r\n'\x22<>]{6,})", re.I, lambda m: m.group(1) + _full("cookie")),
        # Credentials inside URLs.
        ("connection_string", r"\b([a-z][a-z0-9+.\-]{0,30}://)[^:/\s@<>]+:[^@\s/<>]+@", re.I, lambda m: m.group(1) + _full("connection_string") + "@"),
        ("connection_string", r"\b([a-z][a-z0-9+.\-]{0,30}://)[A-Za-z0-9_\-.~%]{20,}@", re.I, lambda m: m.group(1) + _full("connection_string") + "@"),
        ("url_secret", r"([?&;](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|secret|client_secret|password|passwd|pwd|sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|private_token|sessionid|jwt)=)([^&\s'\x22<>#]{4,})", re.I, _keep_prefix("url_secret", 2)),
        # `name = value`, in code, config, JSON, env files and command lines.
        ("password_assignment", r"\b([\w.\-]{0,64}(?:" + _NAMES_STRONG + r")[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{4,})", re.I, lambda m: None if _is_reference(m.group(3)) else m.group(1) + m.group(2) + _full("secret")),
        ("password_assignment", r"\b([\w.\-]{0,64}(?:" + _NAMES_WEAK + r")[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{12,})", re.I, lambda m: None if _is_reference(m.group(3)) else m.group(1) + m.group(2) + _full("secret")),
        ("password_assignment", r"((?:^|\s)--?(?:" + _CLI_NAMES + r")(?:=|[ \t]+))(['\x22]?)([^\s'\x22<>\-][^\s'\x22<>]{2,})", re.I, lambda m: None if _is_reference(m.group(3)) else m.group(1) + m.group(2) + _full("secret")),
        # Personal data.
        ("email", r"\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}\b", 0, lambda m: None if m.group(0).startswith("git@") else _full("email")),
        ("ip", r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b", 0, _ip),
        ("ipv6", r"\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,5}:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4}\b", 0, lambda m: _full("ipv6")),
        ("mac", r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b", 0, lambda m: _full("mac")),
        ("hostname", r"(://|@)(?:[A-Za-z0-9\-]{1,63}\.){1,10}(?:internal|corp|intranet|lan|localdomain|home\.arpa|local)\b", re.I, lambda m: m.group(1) + _full("hostname")),
        ("phone", r"\+[0-9]{1,3}[\s.\-]?\(?[0-9]{2,4}\)?[\s.\-]?[0-9]{3,4}[\s.\-]?[0-9]{3,4}\b", 0, lambda m: _full("phone")),
        ("card", r"\b[3-6](?:[ \-]?[0-9]){12,18}\b", 0, _card),
        ("home_path", r"(/home/|/Users/)[^/\s'\x22<>]+", 0, lambda m: m.group(1) + "<user>"),
        ("home_path", r"([a-z]:\\Users\\)[^\\\s'\x22<>]+", re.I, lambda m: m.group(1) + "<user>"),
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
