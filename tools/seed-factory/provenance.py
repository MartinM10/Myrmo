"""Where a seeded trail comes from, written down when it is made.

Every trail the factory makes carries a `_provenance` record (never published: the publisher drops every key
that starts with an underscore, and keeps the record in `seed-out/provenance.jsonl` next to the colony's
verdict). It answers, years later and without guessing: which task, which image, which version of the factory,
which model if any, built from which sources, under which licences.

The point is the licence policy. Trails are published under CC BY-SA 4.0 and the project keeps the right to
sublicense them (LICENSING.md). That only works if nothing in a seeded trail carries an obligation the project
cannot pass on: no copyleft sources, no share-alike or non-commercial text, no model whose terms forbid it.
`check` refuses a record that breaks the policy, so such a trail never reaches the publisher.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
ROOT = Path(__file__).resolve().parents[2]

# Licences of sources (repositories, datasets, documents) and of models that the project can build on and
# pass on. Permissive only. Anything else (GPL, AGPL, MPL, CC BY-SA, CC BY-NC, no licence, unknown) is out:
# not because it is forbidden to read, but because a trail made from it could carry its terms along.
ALLOWED_LICENCES = {"mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "0bsd", "unlicense", "cc0-1.0"}

# How a source was used. Only `environment` and `discovery` are accepted: a reference that told us an error exists,
# or an environment (an image, a pinned repository) we ran ourselves. Copying its text or code is never accepted.
USES = {"discovery", "environment"}


def licence_allowed(expression: str | None) -> bool:
    """Is every obligation of this SPDX expression one the project can accept? `A AND B` needs both, `A OR B` either.
    Anything that is not clearly a permissive licence is refused, including a missing or unknown one."""
    if not expression or not expression.strip():
        return False
    text = expression.strip()
    tokens = re.findall(r"\(|\)|[^\s()]+", text)
    pos = 0

    def parse_or() -> bool:
        nonlocal pos
        value = parse_and()
        while pos < len(tokens) and tokens[pos].upper() == "OR":
            pos += 1
            value = parse_and() or value  # both sides are parsed, so a malformed tail is still an error
        return value

    def parse_and() -> bool:
        nonlocal pos
        value = parse_atom()
        while pos < len(tokens) and tokens[pos].upper() == "AND":
            pos += 1
            value = parse_atom() and value
        return value

    def parse_atom() -> bool:
        nonlocal pos
        if pos >= len(tokens):
            raise ValueError("incomplete licence expression")
        token = tokens[pos]
        pos += 1
        if token == "(":
            value = parse_or()
            if pos >= len(tokens) or tokens[pos] != ")":
                raise ValueError("unbalanced parenthesis")
            pos += 1
            return value
        if token in (")",) or token.upper() in {"AND", "OR", "WITH"}:
            raise ValueError(f"unexpected {token}")
        if pos < len(tokens) and tokens[pos].upper() == "WITH":  # an exception clause changes the terms: not understood, refused
            pos += 2
            return False
        return token.lower() in ALLOWED_LICENCES

    try:
        value = parse_or()
    except ValueError:
        return False
    return value and pos == len(tokens)


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def factory_version() -> dict:
    """The commit of this checkout, and whether it has changes that commit does not contain."""
    return {"commit": _git("rev-parse", "HEAD") or None, "dirty": bool(_git("status", "--porcelain", "--", "tools/seed-factory", "protocol"))}


def image_digest(image: str) -> str | None:
    """The content digest of the image the task ran in, so `python:3.12.4` today and in a year are told apart."""
    try:
        out = subprocess.run(["docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", image], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    digest = out.stdout.strip()
    return digest if out.returncode == 0 and "@sha256:" in digest else None


def content_hash(public_trail: dict) -> str:
    """Ties the record to the exact trail that was published (without the factory's bookkeeping)."""
    return hashlib.sha256(json.dumps(public_trail, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def record(*, task_id: str, batch: str, image: str, public_trail: dict, sources: list[dict] | None = None,
           model: str | None = None, model_licence: str | None = None, model_terms_reviewed: bool = False,
           digest: str | None = None, version: dict | None = None) -> dict:
    """The provenance of one trail. `sources` are what the task was built from: {"kind", "ref", "licence", "used_as"}.
    The factory's own catalog tasks are written by the project and run scripted commands, so they have no model and
    no outside source. A trail an agent produced names its model and the licence (or reviewed terms) it ran under."""
    return {
        "schema": SCHEMA,
        "origin": "seed-factory",
        "task_id": task_id,
        "batch": batch,
        "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "authored_by": "project",
        "generated_by": {"kind": "model" if model else "scripted-commands", "model": model, "model_licence": model_licence, "model_terms_reviewed": model_terms_reviewed},
        "image": {"ref": image, "digest": digest},
        "tool": version or factory_version(),
        "sources": sources or [],
        "content_sha256": content_hash(public_trail),
    }


def check(rec: dict | None) -> list[str]:
    """Why this record breaks the policy; an empty list means the trail may be published."""
    if not isinstance(rec, dict):
        return ["no provenance record"]
    problems = []
    for field in ("schema", "origin", "task_id", "batch", "executed_at", "generated_by", "image", "tool", "content_sha256"):
        if field not in rec:
            problems.append(f"provenance lacks '{field}'")
    if problems:
        return problems
    if rec["schema"] != SCHEMA:
        problems.append(f"unknown provenance schema {rec['schema']}")
    if not re.fullmatch(r"[0-9a-f]{64}", str(rec["content_sha256"])):
        problems.append("content_sha256 is not a SHA-256")
    if not rec["image"].get("ref"):
        problems.append("the image the task ran in is not recorded")
    generated = rec["generated_by"]
    if generated.get("model"):
        if not (licence_allowed(generated.get("model_licence")) or generated.get("model_terms_reviewed") is True):
            problems.append(f"model {generated['model']}: its licence is not permissive and its terms were not reviewed for this use")
    for source in rec.get("sources", []):
        label = source.get("ref") or source.get("kind") or "source"
        if source.get("used_as") not in USES:
            problems.append(f"source {label}: used as '{source.get('used_as')}', only discovery or environment is accepted (never copied text or code)")
        if not licence_allowed(source.get("licence")):
            problems.append(f"source {label}: licence '{source.get('licence')}' is not one the project can pass on")
    return problems
