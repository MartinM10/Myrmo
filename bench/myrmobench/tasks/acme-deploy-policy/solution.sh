#!/bin/sh
# Reference fix. Never shown to an agent: used by `run.py dry-run` to prove the task can be solved.
cd /work && python3 - <<'PY'
text = open("CHANGELOG.md", encoding="utf-8").read()
record = "## [1.4.2] - 2026-10-11\nTicket: ACME-482\nRollback: 1.4.1\n- Release 1.4.2.\n\n"
open("CHANGELOG.md", "w", encoding="utf-8").write(text.replace("# Changelog\n\n", "# Changelog\n\n" + record, 1))
PY
./deploy.sh staging
