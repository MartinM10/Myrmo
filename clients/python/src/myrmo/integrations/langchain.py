"""LangChain adapter: search the colony whenever a tool fails.

    from myrmo import Colony
    from myrmo.integrations.langchain import MyrmoCallbackHandler

    handler = MyrmoCallbackHandler(Colony(), runtime="python")
    agent.invoke(inputs, config={"callbacks": [handler]})
    handler.latest_hints   # formatted trails for the last tool error, or None
"""

from __future__ import annotations

from typing import Any, List, Optional
from uuid import UUID

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError as exc:  # pragma: no cover
    raise ImportError("pip install 'myrmo[langchain]' to use the LangChain adapter") from exc

from ..client import Colony
from ..format import format_result
from ..packages import detect_packages, detect_runtime


class MyrmoCallbackHandler(BaseCallbackHandler):
    """On every tool error, search Myrmo and keep the formatted trails in `latest_hints`.
    ready to add to the agent's next prompt."""

    raise_error = False

    def __init__(self, colony: Colony, runtime: Optional[str] = None, packages: Optional[List[str]] = None):
        super().__init__()
        self.colony = colony
        self.runtime = runtime
        # None reads the project's own files; an explicit list, even an empty one, is what the caller says.
        self.packages = packages
        self.latest_hints: Optional[str] = None
        self.searches = 0

    def on_tool_error(self, error: BaseException, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        line = f"{type(error).__name__}: {error}".splitlines()[0]
        try:
            packages = self.packages if self.packages is not None else detect_packages(query=line, scoped=self.colony.private)
            detected = None if self.runtime else detect_runtime()
            result = self.colony.search(
                line,
                error_type=type(error).__name__,
                runtime=self.runtime or (detected or {}).get("name"),
                runtime_version=(detected or {}).get("version"),
                packages=packages,
            )
            self.searches += 1
            self.latest_hints = format_result(result)
        except Exception:  # never break the agent because Myrmo is unreachable
            self.latest_hints = None
