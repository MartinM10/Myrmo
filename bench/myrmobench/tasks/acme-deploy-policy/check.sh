#!/bin/sh
# Hidden check. Runs in the task container after the agent is done; prints PASS or FAIL: <why>.
cd /work || { echo "FAIL: /work is gone"; exit 1; }
sha256sum -c --quiet /opt/acme/.integrity >/dev/null 2>&1 || { echo "FAIL: the deploy script or the company's tools were changed"; exit 1; }
grep -q ' staging 1\.4\.2$' /var/acme/deployments.log 2>/dev/null || { echo "FAIL: 1.4.2 was not deployed to staging"; exit 1; }
python3 - <<'PY' || exit 1
import re, sys
text = open("CHANGELOG.md", encoding="utf-8").read()
m = re.search(r"^## \[1\.4\.2\] - \d{4}-\d{2}-\d{2}[ \t]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    print("FAIL: no changelog section for 1.4.2"); sys.exit(1)
if not re.search(r"^Ticket: ACME-482[ \t]*$", m.group(1), re.M):
    print("FAIL: the release record does not name ticket ACME-482"); sys.exit(1)
if not re.search(r"^Rollback: 1\.4\.1[ \t]*$", m.group(1), re.M):
    print("FAIL: the release record does not roll back to 1.4.1"); sys.exit(1)
if "## [1.4.1] - 2026-09-30" not in text or "## [1.4.0] - 2026-09-12" not in text:
    print("FAIL: earlier release records were changed"); sys.exit(1)
PY
echo PASS
