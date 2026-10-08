#!/bin/sh
cd /work || { echo "FAIL: /work is gone"; exit 1; }
grep -q 'chalk' index.js && grep -q '"chalk"' package.json || { echo "FAIL: the program no longer uses chalk"; exit 1; }
out="$(node index.js 2>&1)" || { echo "FAIL: node index.js exits non-zero: $(echo "$out" | head -n 2 | tr '\n' ' ')"; exit 1; }
echo "$out" | grep -q 'hello from myrmobench' || { echo "FAIL: the greeting is not printed"; exit 1; }
echo PASS
