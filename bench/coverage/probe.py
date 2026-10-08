"""A probe: one real breakage, reproduced in a pinned image, from which an error line is captured.

The error line is what an agent would search for. A probe also says where the breakage is documented (a page of a project
with a permissive licence, used only to learn that the error exists), and what a trail must contain to count as an answer
to it (`must`: every pattern has to match the text of the trail).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Probe:
    id: str
    ecosystem: str
    image: str
    setup: str
    command: str
    #: Regex that selects the error line in what the command printed (the first line that matches).
    pick: str
    #: What the breakage involves, for the record: tool and versions.
    versions: dict
    source_url: str
    #: A phrase the source page must contain, so that "verified in the source" means something.
    source_phrase: str
    source_licence: str
    #: Patterns that a trail's text must all match to resolve this error (the rubric).
    must: tuple[str, ...] = field(default=())
    #: The image has to be built from this folder under tools/seed-factory/images first.
    local_image: bool = False


def P(id, ecosystem, image, setup, command, pick, versions, source_url, source_phrase, source_licence, must=(), local_image=False):
    return Probe(id, ecosystem, image, setup.strip(), command.strip(), pick, versions, source_url, source_phrase, source_licence, tuple(must), local_image)
