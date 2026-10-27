#!/usr/bin/env bash
# src/factory/supervise.sh <repo> <runs> <story ...> : supervisor reviews the stories' workstreams and suggests
# changes; AIR applies them (job descriptions, factory/staff.json, pool size). Each is a pi agent; anything it
# writes outside its lane is reverted. Commits the result in <repo> (graph.sh runs this in a worktree).
set -u
PI=$(cd "$(dirname "$0")/../.." && pwd)
REPO=$1 RUNS=$(cd "$2" && pwd); shift 2
cd "$REPO" || exit 1
mkdir -p factory/staff/proposals
P=factory/staff/proposals/$(date +%Y%m%d-%H%M%S).json

# One workstream's record: its steps (station, seconds, tool calls) and its audit (feedback, check output, gate).
record() {
	echo "### Story $1"
	jq -r '.steps[] | "- \(.key) [\(.station)] \(.status) \(((.end // .start) - .start) / 1000 | floor)s \(.calls // 0) calls"' "$RUNS/$1/steps.json" 2>/dev/null
	echo; echo '```'; head -c 8000 "$RUNS/$1/audit.md" 2>/dev/null; echo; echo '```'
}
# The backlog: stories not yet released, with their dependencies; "ready" when every dependency is released.
backlog() {
	local n=0 r=0
	for d in factory/stories/*/; do
		s=$(basename "$d"); git merge-base --is-ancestor "refs/tags/done/$s" HEAD 2>/dev/null && continue
		git rev-parse -q --verify "refs/tags/failed/$s" >/dev/null && continue
		deps=$(grep -o 'Depends on: [a-z0-9-]*' "$d/story.md" 2>/dev/null | sed 's/Depends on: //' | tr '\n' ' ')
		ready=yes; for x in $deps; do [ "$x" = none ] || git merge-base --is-ancestor "refs/tags/done/$x" HEAD 2>/dev/null || ready=no; done
		n=$((n + 1)); [ $ready = yes ] && r=$((r + 1))
		echo "- $s (depends on: ${deps:-none}; ready: $ready)"
	done
	echo "Waiting: $n stories, $r ready to start. Streams: $(jq -r '.streams // empty' factory/staff/pool.json 2>/dev/null || echo "graph.sh default") (running now: ${STREAMS:-?})."
}
stations() { for f in factory/stations/*.md; do echo "### $f"; cat "$f"; echo; done; }
# Throughput by pool size, from graph.sh's factory/staff log of finished stories (end start story result streams).
pool() {
	echo "Current: $(cat factory/staff/pool.json 2>/dev/null || echo '(none; graph.sh default)')"
	awk '{n[$5]++; t[$5]+=$1-$2; if(!($5 in lo)||$2<lo[$5])lo[$5]=$2; if($1>hi[$5])hi[$5]=$1; if($4=="pass")p[$5]++}
		END{for(s in n){h=(hi[s]-lo[s])/3600; printf "- %s streams: %d stories (%d passed), %.1f stories/hour, average story %.0f min\n", s, n[s], p[s], h>0?n[s]/h:0, t[s]/n[s]/60}}' \
		"$RUNS/finished.tsv" 2>/dev/null | sort -n -k2
}
keep() { # keep only files matching the lane patterns; revert the rest
	for f in $(git diff --name-only) $(git ls-files --others --exclude-standard); do
		ok=""; for g in "$@"; do case "$f" in $g) ok=1 ;; esac; done
		case "$f" in factory/stations/_rules.md | factory/stations/release.md) ok="" ;; esac
		[ -n "$ok" ] || git checkout -q -- "$f" 2>/dev/null || rm -f -- "$f"
	done
}

pi -p "$(cat "$PI/src/factory/roles/supervisor.md")

## Task
Review the backlog and these $# workstreams, and write your suggestions to $P.

## Stations
$(stations)

## Staff roles AIR added (factory/staff.json)
$(cat factory/staff.json 2>/dev/null || echo '(none)')

## Backlog
$(backlog)

## Workstreams
$(if [ $# -gt 0 ]; then for s in "$@"; do record "$s"; done; else echo "(none finished yet)"; fi)" </dev/null > "$RUNS/supervisor-$(date +%s).log" 2>&1
keep "$P"
[ -f "$P" ] || { echo "supervisor wrote no $P"; exit 1; }
echo "supervisor: $(jq -c '[.changes[]? | .type + ":" + (.name // .station // "")]' "$P" 2>/dev/null)"

pi -p "$(cat "$PI/src/factory/roles/air.md")

## Task
Apply the supervisor's suggestions and size the pool.

## Backlog
$(backlog)

## Supervisor's suggestions ($P)
$(cat "$P")

## Pool: measured throughput
$(pool)

## Stations
$(stations)

## factory/staff.json
$(cat factory/staff.json 2>/dev/null || echo '(none yet; create it as {"roles": []})')

## factory/staff/log.md (last 40 lines)
$(tail -40 factory/staff/log.md 2>/dev/null || echo '(none yet)')" </dev/null > "$RUNS/air-$(date +%s).log" 2>&1
keep "$P" "factory/stations/*.md" factory/staff.json factory/staff/pool.json factory/staff/log.md
jq -e . factory/staff.json >/dev/null 2>&1 || git checkout -q -- factory/staff.json 2>/dev/null || rm -f factory/staff.json
jq -e '.streams >= 1 and .streams <= 8' factory/staff/pool.json >/dev/null 2>&1 || git checkout -q -- factory/staff/pool.json 2>/dev/null || rm -f factory/staff/pool.json
echo "air: $(git status --short | tr '\n' ' ')"
git add -A factory/staff factory/stations; git add -A factory/staff.json 2>/dev/null
git add -f "$P" 2>/dev/null
git -c user.name=air -c user.email=air@factory.local commit -qm "[staff] supervisor + AIR after: $*" || echo "air: no changes"
