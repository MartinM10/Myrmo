"""Names that fp2 erases, and whether two messages name different things.

The fingerprint replaces paths, URLs and numbers by placeholders, so every `no required module provides package <module>`
is one key whatever the module. An exact lookup can therefore answer with a trail about another package. The names tell
them apart: a Go module path, the repository of a git URL, a registry package, a container image. Absolute paths, files and
numbers are the machine's and are not names.

A port of `placeholder_names` in server/src/relevance.rs; protocol/placeholder_names.v1.vectors.json is normative and the
server, this SDK and the JavaScript SDK must reproduce it exactly.
"""

from __future__ import annotations

import re
from typing import Optional, Set

FILE_EXTENSIONS = frozenset(
    "py js mjs cjs ts tsx jsx rs go java kt c h cc cpp hpp cs rb php json yaml yml toml lock xml csv txt md ini cfg conf sh log "
    "html css sql whl gz zip tar so dll exe pem crt key".split()
)
_SPLIT = re.compile(r"[\s'\"`()\[\]<>,;=]+")
_PUNCTUATION = ":./"


def _name(raw: str) -> Optional[str]:
    token = raw.lower()
    if "://" in token:
        token = token.split("://", 1)[1]
    cut = re.search(r"[?#]", token)
    if cut:
        token = token[: cut.start()]
    # user:password@host/path: the credentials are not part of the name.
    at = token.find("@")
    if at != -1:
        head, tail = token[:at], token[at + 1 :]
        if head and "/" not in head and "/" in tail:
            token = tail
    # name@1.2.3: the version is not part of the name.
    at = token.rfind("@")
    if at != -1:
        head, tail = token[:at], token[at + 1 :]
        if "/" in head and "/" not in tail:
            token = head
    token = token.rstrip(_PUNCTUATION)
    if token.endswith(".git"):
        token = token[:-4].rstrip(_PUNCTUATION)
    # An image tag, or a line and column (`main.rs:5:3`): a colon after the last slash ends the name.
    slash = token.rfind("/")
    if slash != -1:
        colon = token.find(":", slash)
        if colon != -1:
            token = token[:colon]
    if "/" not in token or not (token[0].isascii() and token[0].isalnum()):
        return None
    segments = token.split("/")
    if len(segments) > 8 or any(not segment for segment in segments):
        return None
    last = segments[-1]
    if "." in last and last.rsplit(".", 1)[1] in FILE_EXTENSIONS:
        return None
    host = segments[0].split(":")[0]
    tld = host.rsplit(".", 1)[1] if "." in host else ""
    host_like = host == "localhost" or (len(tld) >= 2 and tld.isascii() and tld.isalpha())
    pair = len(segments) == 2 and "." not in segments[0]
    if (host_like or pair) and any(c.isascii() and c.isalpha() for c in token):
        return token
    return None


def placeholder_names(text: str) -> Set[str]:
    return {name for name in (_name(raw) for raw in _SPLIT.split(text) if raw) if name}


def _share_a_name(a: Set[str], b: Set[str]) -> bool:
    return any(
        x == y or x.startswith(y + "/") or y.startswith(x + "/") or x.rsplit("/", 1)[-1] == y.rsplit("/", 1)[-1]
        for x in a
        for y in b
    )


def names_conflict(query: str, message: str) -> bool:
    """True when the query and the message both spell such names and share none: another package, so another error."""
    asked = placeholder_names(query)
    if not asked:
        return False
    have = placeholder_names(message)
    return bool(have) and not _share_a_name(asked, have)
