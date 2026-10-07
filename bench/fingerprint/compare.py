"""Does the error fingerprint find a repeat of an error that a trail already solves?

    python bench/fingerprint/compare.py

The fingerprint (fp1) hashes the runtime, the error type and the normalised message. A trail declares its error type
(what its author chose) and a searcher can only guess one from the error line, so the two often disagree and the cheap,
cacheable exact lookup misses. This compares fp1 with keys that need only the message, on two sets of trails:

  * the 24 public trails of the production colony written by agents (`production-trails.json`, a snapshot), and
  * the 46 trails of the retrieval benchmark corpus.

For each trail it builds the searches of bench/retrieval/run.py (the error as published, on another machine, wrapped
in another exception, without its type prefix) and counts how many produce the key the trail is stored under. It also
counts collisions (one key for trails with different declared type or runtime) and false hits of unrelated searches.

Nothing here changes the protocol: the message-only keys are candidates for a future fp2, measured before deciding.
Needs the `myrmo` Python SDK (`pip install -e clients/python`).
"""

from __future__ import annotations

import collections
import hashlib
import importlib.util
import json
import random
import re
import sys
from pathlib import Path

from myrmo.fingerprint import fingerprint as fp1
from myrmo.fingerprint import guess_error_type, normalize_message

HERE = Path(__file__).resolve().parent
RETRIEVAL = HERE.parent / "retrieval"

spec = importlib.util.spec_from_file_location("retrieval_run", RETRIEVAL / "run.py")
run = importlib.util.module_from_spec(spec)
sys.modules["retrieval_run"] = run
spec.loader.exec_module(run)

# -- candidate keys: what a searcher can compute from the error line alone ----------------------------------------

SEVERITY = r"(?i:error|fatal|warning|panic|err|exception)"
EXCEPTION_CLASS = r"(?:[a-z_][\w$]*\.)*[A-Z][\w$]*(?:Error|Exception|Warning|Failure)"
LEADING = re.compile(rf"^\s*(?:{EXCEPTION_CLASS}|{SEVERITY}(?:\[\w+\])?|npm ERR!|npm error)\s*:\s+")


def strip_prefixes(message: str, times: int) -> str:
    """Drop up to `times` leading exception classes or severity words ("java.lang.IllegalStateException: ", "error: ")."""
    for _ in range(times):
        shorter = LEADING.sub("", message, count=1)
        if shorter == message:
            break
        message = shorter
    return message


def key(*parts: str) -> str:
    return "fp2_" + hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:16]


def current(runtime: str, _type: str, message: str) -> str:
    return fp1(runtime, guess_error_type(message), message)  # what a client computes today


def message_one(runtime: str, _type: str, message: str) -> str:
    return key(normalize_message("", strip_prefixes(message, 1)))


def message_wrapped(runtime: str, _type: str, message: str) -> str:
    return key(normalize_message("", strip_prefixes(message, 3)))


def runtime_message_wrapped(runtime: str, _type: str, message: str) -> str:
    return key(runtime.lower(), normalize_message("", strip_prefixes(message, 3)))


SCHEMES = {
    "fp1 today (runtime + guessed type)": current,
    "message only, one prefix": message_one,
    "message only, wrapped exceptions too": message_wrapped,
    "runtime + message, wrapped too": runtime_message_wrapped,
}
VARIANTS = ["exact", "shifted", "wrapped", "no_type_prefix"]


def stored_key(scheme: str, trail: dict) -> str:
    """The key the colony files the trail under: computed from what the trail declares."""
    runtime = trail["environment"]["runtime"]["name"]
    problem = trail["problem"]
    message = (problem.get("error_message") or problem["error_type"]).strip()
    if scheme.startswith("fp1"):
        return fp1(runtime, problem["error_type"], message)
    return SCHEMES[scheme](runtime, problem["error_type"], message)


def distinct(trails: list[dict]) -> list[dict]:
    seen, out = set(), []
    for t in trails:
        k = (t["problem"]["error_type"].lower(), (t["problem"].get("error_message") or "").lower()[:120])
        if k not in seen:
            seen.add(k)
            out.append(t)
    return out


def as_trail(row: dict) -> dict:
    return {"environment": {"runtime": {"name": row["runtime"], "version": "0"}}, "problem": {"error_type": row["error_type"], "error_message": row["error_message"]}}


def main() -> None:
    production = [as_trail(r) for r in json.loads((HERE / "production-trails.json").read_text(encoding="utf-8"))["trails"]]
    corpus = [json.loads(line)["trail"] for line in (RETRIEVAL / "corpus.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    sets = {"production, written by agents": distinct(production), "retrieval benchmark corpus": distinct(corpus)}
    negatives = json.loads((RETRIEVAL / "negatives.json").read_text(encoding="utf-8"))
    searches = negatives["queries"] + negatives["lookalikes"]

    for name, trails in sets.items():
        print(f"\n{name} ({len(trails)} trails)")
        print(f"{'key':40}" + "".join(f"{v:>16}" for v in VARIANTS))
        for scheme, fn in SCHEMES.items():
            cells = []
            for v in VARIANTS:
                hits = total = 0
                for i, trail in enumerate(trails):
                    queries = {variant: text for variant, text, _ in run.positives(trail, random.Random(f"7:{i}"))}
                    if v not in queries:
                        continue
                    total += 1
                    hits += fn(trail["environment"]["runtime"]["name"], "", queries[v]) == stored_key(scheme, trail)
                cells.append(f"{hits}/{total}")
            print(f"{scheme:40}" + "".join(f"{c:>16}" for c in cells))
        for scheme in list(SCHEMES)[1:]:
            groups = collections.defaultdict(list)
            for t in trails:
                groups[stored_key(scheme, t)].append(t)
            clashes = [g for g in groups.values() if len({(x["problem"]["error_type"].lower(), x["environment"]["runtime"]["name"].lower()) for x in g}) > 1]
            keys = set(groups)
            false_hits = sum(1 for q in searches if SCHEMES[scheme](q.get("runtime") or "", "", q["error"]) in keys)
            print(f"  {scheme:38} trails sharing a key: {len(clashes)}   unrelated searches that hit a key: {false_hits} of {len(searches)}")


if __name__ == "__main__":
    main()
