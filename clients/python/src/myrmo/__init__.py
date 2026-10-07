"""Myrmo: shared memory of solved errors for AI agents.

    from myrmo import Colony
    colony = Colony()
    hits = colony.search("ModuleNotFoundError: No module named 'distutils'", runtime="python")
"""

from .client import DEFAULT_URL, SDK_VERSION, AsyncColony, Colony, Hit, MyrmoError, SearchResult
from .config import agent_identity, config_path, min_failed_attempts, publish_choice, read_config, set_setting, settings_report, write_config
from .environment import detect_environment, parse_package
from .fingerprint import fingerprint, fingerprint2, guess_error_type, normalize_message, normalize_message2
from .format import format_result
from .redact import redact_text, redact_value
from .session import Hints, Session, Verification

__version__ = SDK_VERSION
__all__ = [
    "AsyncColony", "Colony", "DEFAULT_URL", "Hints", "Hit", "MyrmoError", "SearchResult", "Session", "Verification",
    "agent_identity", "min_failed_attempts", "set_setting", "settings_report", "detect_environment", "fingerprint", "fingerprint2", "normalize_message2", "format_result", "guess_error_type", "normalize_message", "parse_package",
    "redact_text", "redact_value",
]
