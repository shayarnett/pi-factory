#!/usr/bin/env bash
# Runs stories in order on one repo; each builds on the last. Stops at the first failed gate.
cd "$(dirname "$0")/../.."
REPO=~/acme
while pgrep -f "run.ts --repo .* --story" >/dev/null; do sleep 30; done
for s in url-user-shortens-url url-visitor-follows-short-link url-user-copies-short-link url-visit-is-counted \
         url-user-sees-total-clicks url-user-sees-daily-clicks url-user-sees-top-referrers url-stats-are-private; do
  if [ ! -f "runs/$s/audit.md" ]; then
    echo "$(date +%T) start $s"
    LOCAL_LLM_BASE_URL=http://127.0.0.1:18888/v1 npx tsx src/factory/run.ts --repo "$REPO" --story "$s" > "runs/$s.log" 2>&1
  fi
  if grep -q "bin/rails test: pass" "runs/$s/audit.md" && grep -q "bin/rails test:system: pass" "runs/$s/audit.md"; then
    echo "$(date +%T) PASS $s ($(git -C $REPO log --oneline start/$s..HEAD | wc -l | tr -d ' ') commits)"
  else
    echo "$(date +%T) FAIL $s — stopping"; exit 1
  fi
done
echo "$(date +%T) all stories done"
