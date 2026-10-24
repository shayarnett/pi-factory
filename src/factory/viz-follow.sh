#!/usr/bin/env bash
# Keeps the dashboard (port 8787) on the newest factory run, restarting it when a new story starts.
cd "$(dirname "$0")/../.."
cur=""
while true; do
  new=$(ls -t runs/*/steps.json 2>/dev/null | head -1 | xargs dirname)
  if [ -n "$new" ] && [ "$new" != "$cur" ]; then
    pkill -f "src/viz.ts" ; sleep 1
    nohup npx tsx src/viz.ts --run "$new" > runs/viz.log 2>&1 &
    cur=$new; echo "$(date +%T) viz -> $new"
  fi
  sleep 30
done
