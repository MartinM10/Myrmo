"""Tasks drafted by an agent from a breakage lead (worker.py), one JSON file each in tools/seed-factory/drafts/.

A draft is only text and commands: the factory runs it in a fresh container like any other task, and the quality gates
decide whether it becomes a trail. Drafts that the factory rejected are kept with the reason (`_factory_error`) so the
worker can try again; they still load here, since running them is how they are judged.
"""

import json
from pathlib import Path

from .base import Task

DRAFTS = Path(__file__).resolve().parents[1] / "drafts"
FIELDS = ("task_id", "image", "runtime", "category", "error_type", "summary", "context", "setup", "failing_command",
          "failed_approaches", "fix_command", "verification_command", "root_cause", "steps", "tags")


def load(path: Path) -> Task:
    d = json.loads(path.read_text(encoding="utf-8"))
    missing = [f for f in FIELDS if f not in d]
    if missing:
        raise ValueError(f"{path.name}: missing {missing}")
    return Task(
        **{f: d[f] for f in FIELDS if f not in ("failed_approaches", "steps", "tags")},
        failed_approaches=tuple(d["failed_approaches"]), steps=tuple(d["steps"]), tags=tuple(d["tags"]),
        ecosystem=d.get("ecosystem", "radar"), written_by_model=d.get("written_by_model"), memory=d.get("memory", "1g"),
    )


TASKS = tuple(load(p) for p in sorted(DRAFTS.glob("*.json"))) if DRAFTS.is_dir() else ()
