"""The tasks the factory can run, one module per ecosystem.

`TASKS` is every task; `publishable()` leaves out the ones the publication policy excludes. A module that exports
`TASKS` (a tuple of `Task`) is picked up here by listing it in MODULES.
"""

import importlib

from .base import Task
from .legacy import LEGACY

#: One module per ecosystem (catalog/<name>.py exporting TASKS). Add a name here to bring its tasks in.
MODULES = ("python", "node", "jvm", "go", "rust", "dotnet", "docker", "tls", "platform", "drafts")


def _load() -> tuple[Task, ...]:
    tasks = list(LEGACY)
    for name in MODULES:
        try:
            module = importlib.import_module(f"{__name__}.{name}")
        except ModuleNotFoundError as err:
            if err.name != f"{__name__}.{name}":
                raise
            continue  # a module that does not exist yet
        tasks.extend(module.TASKS)
    ids = [t.task_id for t in tasks]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"duplicate task ids: {sorted(duplicates)}")
    return tuple(tasks)


TASKS = _load()


# A trail is worth publishing only when an agent that hits the error would plausibly search for it
# and the fix does not depend on the agent's own code. Errors a capable agent solves at a glance are
# never searched, and errors in someone's source code have fixes that do not transfer. Tasks listed
# here stay in the catalog (they are reproducible and useful as tests) but are not published.
POLICY_EXCLUDED = {
    # The fix is a change to the user's own source code.
    "rust-borrow-checker": "code-level: the fix depends on the user's code",
    "rust-use-after-move": "code-level: the fix depends on the user's code",
    "rust-type-mismatch": "code-level: the fix depends on the user's code",
    "typescript-type-error": "code-level: the fix depends on the user's code",
    "go-type-mismatch": "code-level: the fix depends on the user's code",
    "go-undefined-symbol": "code-level: the fix depends on the user's code",
    "cpp-missing-header": "code-level: the fix depends on the user's code",
    "cpp-undefined-reference": "code-level: the fix depends on the user's code",
    "cpp-multiple-definition": "code-level: the fix depends on the user's code",
    "python-syntax-error": "code-level: the fix depends on the user's code",
    "python-indentation-error": "code-level: the fix depends on the user's code",
    "python-division-by-zero": "code-level: the fix depends on the user's code",
    "python-empty-environment-variable": "code-level: the fix depends on the user's code",
    "node-env-port": "code-level: the fix depends on the user's code",
    # The task does not reproduce what its trail would claim.
    "docker-exec-format": "not reproduced: the container shell reports 'not found', not the kernel's exec format error",
    # Obvious at a glance: an agent solves it without searching, so nobody would look it up.
    "python-invalid-json": "obvious: an agent fixes it at a glance",
    "node-json-parse": "obvious: an agent fixes it at a glance",
    "python-unicode-decode": "obvious: an agent fixes it at a glance",
    "missing-config-path": "obvious: an agent fixes it at a glance",
    "python-dns-resolution": "obvious: an agent fixes it at a glance",
    "python-permission-file": "obvious: an agent fixes it at a glance",
    "permissions-non-executable": "obvious: an agent fixes it at a glance",
    "python-port-in-use": "obvious: an agent fixes it at a glance",
    "node-missing-module": "obvious: an agent fixes it at a glance",
    "python-missing-requests": "obvious: an agent fixes it at a glance",
    "go-missing-module": "obvious: an agent fixes it at a glance",
    "go-missing-package": "obvious: an agent fixes it at a glance",
}


def publishable() -> tuple[Task, ...]:
    return tuple(t for t in TASKS if t.task_id not in POLICY_EXCLUDED)


# For the few tasks whose captured output does not carry the message people actually search for on
# one line, the line to use. It is only used when the container really printed it.
MESSAGE_OVERRIDES = {
    "node-openssl-md4": "Error: error:0308010C:digital envelope routines::unsupported",
    "git-safe-directory": "fatal: detected dubious ownership in repository",
}


def ecosystem_of(task: Task) -> str:
    """The ecosystem a task belongs to: its own field, or `legacy` for the first catalog."""
    return task.ecosystem or "legacy"


from .probes import MESSAGES as _PROBE_MESSAGES  # noqa: E402

MESSAGE_OVERRIDES.update(_PROBE_MESSAGES)
