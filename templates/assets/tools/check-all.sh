#!/usr/bin/env bash
# tools/check-all.sh : runs tools/check.sh on every asset; exits 1 if any fails. The release suite.
cd "$(dirname "$0")/.."
fail=0
for b in assets/*/build.py; do
	s=$(basename "$(dirname "$b")")
	if tools/check.sh "$s" > /tmp/check-$s.log 2>&1; then echo "PASS $s"; else echo "FAIL $s"; grep FAIL /tmp/check-$s.log; fail=1; fi
done
git checkout -q -- assets 2>/dev/null # rebuilds are not byte-identical; keep the committed files
exit $fail
