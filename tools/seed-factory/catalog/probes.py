"""Tasks that start from a probe of bench/coverage.

A probe is a real breakage reproduced in a pinned image. A task adds what the probe does not have: the dead ends, the fix,
the verification and the words. The failing command, the image and the setup come from the probe, so the error line the
coverage set measures is the one the trail is about.

A line of the reserved half of the coverage set can never become a task: coverage is measured on it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .base import Task

ROOT = Path(__file__).resolve().parents[3]
COVERAGE = ROOT / "bench" / "coverage"
MODEL = "claude-sonnet-5-5"

if str(COVERAGE) not in sys.path:
    sys.path.insert(0, str(COVERAGE))


def _lines() -> dict:
    path = COVERAGE / "lines.jsonl"
    return {row["id"]: row for row in map(json.loads, path.read_text(encoding="utf-8").splitlines() if path.exists() else [])}


def _probes() -> dict:
    from capture import all_probes  # noqa: PLC0415 (needs COVERAGE on sys.path)

    return {p.id: p for p in all_probes()}


def from_probe(probe_id: str, *, category: str, error_type: str, summary: str, context: str, failed_approaches: tuple[str, ...],
               fix: str, verify: str, root_cause: str, steps: tuple[str, ...], tags: tuple[str, ...], runtime: dict,
               extra_setup: str = "", failing: str | None = None, memory: str = "512m", message: str | None = None) -> Task:
    """`failing` replaces the probe's command when the task runs a file that `extra_setup` wrote; `message` is a piece of the
    line to keep as the trail's error message when the output has several candidates."""
    lines, probes = _lines(), _probes()
    line = lines.get(probe_id)
    if line is None:
        raise ValueError(f"{probe_id}: not in the coverage lines (not captured, or its source was not verified)")
    if line["split"] != "candidate":
        raise ValueError(f"{probe_id}: it belongs to the reserved half of the coverage set and cannot become a task")
    probe = probes[probe_id]
    setup = probe.setup if not extra_setup else f"{probe.setup}\n{extra_setup}"
    task = Task(
        task_id=probe_id, image=probe.image, runtime=runtime, category=category, error_type=error_type, summary=summary,
        context=context, setup=setup, failing_command=failing or probe.command, failed_approaches=failed_approaches,
        fix_command=fix, verification_command=verify, root_cause=root_cause, steps=steps, tags=tags,
        ecosystem=probe.ecosystem, written_by_model=MODEL, probe=probe_id, memory=memory,
    )
    if message:
        MESSAGES[probe_id] = message
    return task


#: Task id -> a piece of the line to keep as the error message (see factory.error_line).
MESSAGES: dict[str, str] = {}
