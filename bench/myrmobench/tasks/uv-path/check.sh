#!/bin/sh
# Hidden check. Runs in the task container after the agent is done; prints PASS or FAIL: <why>.
cd /work || { echo "FAIL: /work is gone"; exit 1; }
grep -q 'uv venv' build.sh && grep -q 'uv pip install' build.sh && grep -q 'six' build.sh \
  || { echo "FAIL: build.sh no longer builds with uv"; exit 1; }
out="$(env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin ./build.sh 2>&1)" \
  || { echo "FAIL: ./build.sh exits non-zero: $(echo "$out" | tail -n 2 | tr '\n' ' ')"; exit 1; }
echo "$out" | grep -q 'BUILD OK' || { echo "FAIL: no BUILD OK"; exit 1; }
echo "$out" | grep -q '^six ' || { echo "FAIL: six was not installed by the build"; exit 1; }
echo PASS
