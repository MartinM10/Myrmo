"""A session wraps one task: it searches the colony on every new error, records failed
approaches, and drafts a trail when the task finally succeeds after enough failures."""

from __future__ import annotations

import os
import platform
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Union

from .client import Colony, SearchResult
from .environment import detect_environment
from .config import min_failed_attempts as _min_failed_attempts
from .format import format_result


@dataclass
class Verification:
    type: str
    description: str
    command: Optional[str] = None
    evidence: Optional[str] = None

    @classmethod
    def command(cls, command: str, evidence: str = "", description: str = "") -> "Verification":
        return cls("command_exit_zero", description or f"`{command}` succeeds", command, evidence or None)

    @classmethod
    def tests(cls, command: str, evidence: str = "") -> "Verification":
        return cls("test_suite", "The test suite passes", command, evidence or None)

    def as_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Hints:
    result: SearchResult

    def as_prompt(self) -> str:
        """Ready to append to the model's context, wrapped as untrusted data."""
        return format_result(self.result)


class Session:
    def __init__(
        self,
        colony: Colony,
        task: str,
        runtime: str = "python",
        runtime_version: Optional[str] = None,
        packages: Sequence[Union[str, Dict[str, str]]] = (),
        agent: Optional[Dict[str, str]] = None,
        min_failed_attempts: Optional[int] = None,
    ):
        self.colony = colony
        self.task = task
        self.runtime = runtime
        self.runtime_version = runtime_version or (platform.python_version() if runtime == "python" else "unknown")
        self.packages = list(packages)
        self.agent = agent or {"model": "unknown", "framework": "myrmo-python"}
        self.min_failed_attempts = _min_failed_attempts(min_failed_attempts)[0]
        self.failures: List[Dict[str, str]] = []
        self.matched_existing = False
        #: Trails the agent followed that did not (fully) work: its own fix may be a better alternative.
        self.tried_failed: List[Dict[str, str]] = []
        self.solved_by_trail = False
        self.draft: Optional[Dict[str, Any]] = None
        self.published: Optional[Dict[str, Any]] = None
        self._started = time.monotonic()

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *exc) -> None:
        return None

    def failed(self, error: Union[BaseException, str], approach: str = "previous attempt") -> Hints:
        """Record a failed attempt and search the colony for its error."""
        if isinstance(error, BaseException):
            error_type = type(error).__name__
            line = f"{error_type}: {error}".splitlines()[0]
            logs = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        else:
            line = next((l for l in str(error).splitlines() if l.strip()), str(error))
            error_type = line.split(":", 1)[0].strip() if ":" in line else "Error"
            logs = str(error)
        self.failures.append({"approach": approach, "why": line[:500], "error_type": error_type[:128], "message": line[:1000], "logs": logs[-16000:]})
        result = self.colony.search(line, error_type=error_type, runtime=self.runtime, runtime_version=self.runtime_version, packages=self.packages)
        if result.hits:
            self.matched_existing = True
        return Hints(result)

    def tried(self, trail_id: str, outcome: str, notes: str = "") -> Dict[str, Any]:
        """Report what happened when the agent followed a trail. A trail that failed or only partly
        worked is what makes a different fix worth publishing as an alternative, even though the
        colony already had an answer. A trail that worked means there is nothing new to publish."""
        result = self.colony.report(trail_id, outcome, notes or None, agent_info=self.agent)
        if outcome == "worked":
            self.solved_by_trail = True
        if outcome in ("failed", "partially_worked"):
            self.tried_failed.append({"id": trail_id, "outcome": outcome, "notes": notes})
        return result

    def succeeded(
        self,
        verification: Verification,
        root_cause: str,
        steps: Sequence[str],
        summary: Optional[str] = None,
        commands: Sequence[Dict[str, Any]] = (),
        patches: Sequence[Dict[str, Any]] = (),
        tags: Sequence[str] = (),
        tokens_spent: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """The task succeeded. Returns the drafted trail when it is worth publishing and
        publishes it when the colony's publish mode is "auto". In "ask" mode, show
        `colony.preview(draft)` to the user and call `colony.publish(draft)` after approval."""
        # Nothing new when an existing trail already solved it, or when one matched and was never tried.
        covered = self.solved_by_trail or (self.matched_existing and not self.tried_failed)
        if not self.failures or len(self.failures) < self.min_failed_attempts or covered or verification.type == "none":
            return None
        last = self.failures[-1]
        env = detect_environment(self.packages)
        env["runtime"] = {"name": self.runtime, "version": self.runtime_version}
        summary = (summary or f"{self.task}: {last['message']}")[:1000]
        self.draft = {
            "protocol_version": "1.0",
            "agent_info": self.agent,
            "environment": env,
            "problem": {
                "error_type": last["error_type"],
                "error_message": last["message"],
                "summary": summary if len(summary) >= 20 else summary.ljust(20, "."),
                "task_context": self.task[:1000],
                "raw_logs": last["logs"] or last["message"],
                "failed_approaches": [{"approach": f["approach"][:500], "why_it_failed": f["why"]} for f in self.failures[:-1]]
                + [
                    {
                        "approach": f"Followed Myrmo trail {t['id']}",
                        "why_it_failed": (t["notes"] or ("it did not work in this environment" if t["outcome"] == "failed" else "it only partly worked"))[:500],
                    }
                    for t in self.tried_failed
                ],
            },
            "solution": {
                "root_cause": root_cause,
                "steps": list(steps),
                "shell_commands_executed": list(commands),
                "code_patches": list(patches),
                "verification_method": verification.as_dict(),
            },
            "effort": {
                "failed_attempts": len(self.failures),
                "wall_time_seconds": round(time.monotonic() - self._started),
                **({"tokens_spent": tokens_spent} if tokens_spent else {}),
            },
            **({"tags": list(tags)} if tags else {}),
        }
        if self.colony.publish_mode == "auto":
            self.published = self.colony.publish(self.draft)
        return self.draft
