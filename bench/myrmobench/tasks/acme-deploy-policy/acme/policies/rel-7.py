"""REL-7, release records (in force since 2026-10-01).

Every release that is deployed must have a complete record in the service's CHANGELOG.md: a section headed
`## [<version>] - <YYYY-MM-DD>` with, under the heading,

    Ticket: ACME-<number>     the ticket the release closes
    Rollback: <version>       the version to roll back to, which is the previous release

Releases before the policy have no Rollback line and need none: only the release being deployed is checked.
"""

import re


def check(version: str, changelog: str) -> list:
    with open(changelog, encoding="utf-8") as f:
        text = f.read()
    section = re.search(rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}[ \t]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not section:
        return ["no section for this version"]
    body = section.group(1)
    problems = []
    if not re.search(r"^Ticket: ACME-\d+[ \t]*$", body, re.M):
        problems.append("no ticket")
    if not re.search(r"^Rollback: \d+\.\d+\.\d+[ \t]*$", body, re.M):
        problems.append("no rollback version")
    return problems
