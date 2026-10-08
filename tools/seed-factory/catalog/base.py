from dataclasses import dataclass


@dataclass(frozen=True)
class Task:
    task_id: str
    image: str
    runtime: dict
    category: str
    error_type: str
    summary: str
    context: str
    setup: str
    failing_command: str
    failed_approaches: tuple[str, ...]
    fix_command: str
    verification_command: str
    root_cause: str
    steps: tuple[str, ...]
    tags: tuple[str, ...]
    # Set for tasks written after the first catalog. The first ones are scripted by the project.
    ecosystem: str = ""
    #: The model that wrote the task's text (summary, root cause, steps). The commands and their output are real.
    written_by_model: str | None = None
    #: The probe in bench/coverage the failing command comes from, when there is one.
    probe: str = ""
    #: Memory for each container of the task (Docker syntax). Compilers and package managers need more than the default.
    memory: str = "512m"
