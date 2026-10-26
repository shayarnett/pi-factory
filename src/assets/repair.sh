#!/usr/bin/env bash
# src/assets/repair.sh <repo> <jobs> <slug ...> : rebuilds existing assets through src/assets/run.ts, each in its own
# worktree (branch repair/<slug>); merges the ones whose gate passes into the repo's current branch.
set -u
cd "$(dirname "$0")/../.."
REPO=$(cd "$1" && pwd); JOBS=$2; shift 2
WT=$REPO-wt
one() {
	s=$1; w=$WT/repair-$s
	git -C "$REPO" worktree add -q -f -B "repair/$s" "$w" HEAD && ln -sf "$REPO/node_modules" "$w/node_modules"
	LOCAL_LLM_BASE_URL=http://127.0.0.1:18888/v1 npx tsx src/assets/run.ts --repo "$w" --story "$s" > "runs/repair-$s.log" 2>&1
	if grep -q "gate: pass" "runs/$s/audit.md"; then echo "$(date +%T) PASS $s"; else echo "$(date +%T) FAIL $s"; fi
}
export -f one; export REPO WT
printf '%s\n' "$@" | xargs -P "$JOBS" -I{} bash -c 'one {}' | while read -r t r s; do
	echo "$t $r $s"
	[ "$r" = PASS ] || continue
	git -C "$REPO" merge -q --no-edit "repair/$s" && git -C "$REPO" worktree remove --force "$WT/repair-$s" && echo "$t merged $s"
done
