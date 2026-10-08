#!/bin/sh
cd /work || { echo "FAIL: /work is gone"; exit 1; }
if grep -Eq -- '(^|[[:space:]])(-k|--insecure)([[:space:]]|$)|CURL_CA_BUNDLE=|verify' fetch.sh; then
  echo "FAIL: fetch.sh switches certificate verification off or replaces the trust store"; exit 1
fi
out="$(env -i PATH=/usr/local/bin:/usr/bin:/bin ./fetch.sh 2>&1)" \
  || { echo "FAIL: ./fetch.sh exits non-zero: $(echo "$out" | head -n 2 | tr '\n' ' ')"; exit 1; }
echo "$out" | grep -q 'ok intranet health' || { echo "FAIL: not the service's answer"; exit 1; }
[ -f ~/.curlrc ] && grep -Eq 'insecure|^-k' ~/.curlrc && { echo "FAIL: verification switched off in ~/.curlrc"; exit 1; }
echo PASS
