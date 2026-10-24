#!/usr/bin/env bash
# Runs stories as a dependency graph: up to MAX work streams (one story each, in its own git worktree), plus one
# release slot that lands finished stories on main one at a time.
# A story starts when every story it "Depends on:" is released. Release: merge the story branch into main, run the
# full suite; on a conflict or a red suite the release station (pi agent) fixes only the files involved. A failed
# gate or release stops new starts; main is put back to the last release.
#
#   src/factory/graph.sh [story ...]   # default: every story not yet released; adopts stories already running
#   FAKE=1 REPO=<clone> WT=<dir> RUNS=<dir> src/factory/graph.sh   # stub stations, to test the mechanics
cd "$(dirname "$0")/../.."
PI=$PWD
REPO=${REPO:-~/acme}
WT=${WT:-~/acme-wt}
RUNS=${RUNS:-$PI/runs}
MAX=${MAX:-4}
export LOCAL_LLM_BASE_URL=http://127.0.0.1:18888/v1
mise_env() { eval "$(mise env -C "$1" -s bash)"; }
log() { echo "$(date +%T) $*"; }

cd "$REPO" || exit 1
[ "$(git branch --show-current)" = main ] || { log "$REPO must be on main"; exit 1; }
merged() { [ "$1" = user-signs-up ] || git merge-base --is-ancestor "refs/tags/done/$1" main 2>/dev/null; }
deps() { grep -o 'Depends on: [a-z0-9-]*' "$REPO/factory/stories/$1/story.md" | sed 's/Depends on: //'; }
suite() { [ -n "$FAKE" ] || (mise_env "$REPO" && bin/rails db:prepare >/dev/null 2>&1 && bin/rails test >"$1" 2>&1 && bin/rails test:system >>"$1" 2>&1); }

todo=""
running="" # "story:pid" pairs
for s in ${@:-$(ls factory/stories)}; do
	merged "$s" && continue
	pid=$(pgrep -o -f "run.ts --repo $WT/$s --story $s")
	if [ -n "$pid" ]; then running="$running $s:$pid"; log "adopt $s (pid $pid)"
	elif git rev-parse -q --verify "story/$s" >/dev/null && grep -q "bin/rails test:system: pass" "$RUNS/$s/audit.md" 2>/dev/null; then
		running="$running $s:0"; log "pending release: $s" # finished earlier; release it without rebuilding
	else todo="$todo $s"; fi
done
log "todo:$todo"
stop=""

launch() {
	local s=$1 dir=$WT/$1
	rm -rf "$RUNS/$s"
	git tag -d "start/$s" >/dev/null 2>&1
	git worktree remove --force "$dir" 2>/dev/null
	git worktree add -q -B "story/$s" "$dir" main
	(cd "$dir" && mise trust -q . && mise_env "$dir" && bin/rails db:prepare >/dev/null 2>&1)
	log "start $s"
	if [ -n "$FAKE" ]; then
		(sleep $((RANDOM % 5 + 2)); cd "$dir" && echo "<!-- $s -->" >> app/views/home/index.html.erb && echo "/* $s */" >> app/assets/stylesheets/home.css && git add -A &&
			git -c user.name=fake -c user.email=f@x commit -qm "[fake] $s" && mkdir -p "$RUNS/$s" &&
			printf -- '- bin/rails test: pass\n- bin/rails test:system: pass\n' > "$RUNS/$s/audit.md") &
	else
		(cd "$PI" && npx tsx src/factory/run.ts --repo "$dir" --story "$s" > "$RUNS/$s.log" 2>&1) &
	fi
	running="$running $s:$!"
}

# Release station: the pi agent, allowed to change only $files; anything else it touches is reverted.
release_fix() {
	local s=$1 why=$2 files out=$RUNS/release-$s.log
	files=$(echo $3) # one line, space-separated
	log "release station: $why in $s ($(echo $files | wc -w | tr -d ' ') files)"
	if [ -n "$FAKE" ]; then
		for f in $files; do grep -v '^\(<<<<<<<\|=======\|>>>>>>>\)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
	else
		pi -p "$(cat factory/stations/_rules.md factory/stations/release.md)

## Task
Story \`$s\` was merged into main: $why.
Files you may edit: $files

$(cat "$RUNS/release-$s.suite" 2>/dev/null | tail -60)" </dev/null >>"$out" 2>&1
	fi
	for f in $(git diff --name-only) $(git ls-files --others --exclude-standard); do
		case " $files " in *" $f "*) git add -- "$f" ;; *) git checkout -q -- "$f" 2>/dev/null || rm -rf -- "$f" ;; esac
	done
}

finish() {
	local s=$1 a=$RUNS/$1/audit.md base
	if ! { grep -q "bin/rails test: pass" "$a" && grep -q "bin/rails test:system: pass" "$a"; } 2>/dev/null; then
		log "FAIL gate $s (worktree kept: $WT/$s)"; stop=1; return
	fi
	base=$(git rev-parse HEAD)
	if ! git merge -q --no-ff --no-commit "story/$s" >/dev/null 2>&1; then
		local conflicted=$(echo $(git diff --name-only --diff-filter=U))
		release_fix "$s" "it conflicted" "$conflicted"
		if git diff --name-only --diff-filter=U | grep -q . || grep -l '^<<<<<<<\|^>>>>>>>' $conflicted >/dev/null 2>&1; then
			git merge --abort; log "FAIL release $s: conflict not resolved (branch story/$s kept)"; stop=1; return
		fi
		git add -- $conflicted
	fi
	git -c user.name=release -c user.email=release@factory.local commit -qm "release: $s" --no-edit
	if ! suite "$RUNS/release-$s.suite"; then
		release_fix "$s" "the full suite failed after the merge" "$(git diff --name-only "$base" HEAD)"
		git diff --cached --quiet || git -c user.name=release -c user.email=release@factory.local commit -qm "release: fix $s integration"
		if ! suite "$RUNS/release-$s.suite"; then
			git reset -q --hard "$base"; log "FAIL release $s: suite still red, main reset (branch story/$s kept)"; stop=1; return
		fi
	fi
	local n=$(( $(git tag -l 'release/*' | wc -l) + 1 ))
	git tag -f "done/$s" HEAD >/dev/null
	git tag "release/$n" HEAD
	git worktree remove --force "$WT/$s" 2>/dev/null
	log "RELEASE $n: $s"
}

while [ -n "$todo$running" ]; do
	still=""
	for sp in $running; do
		if [ "${sp#*:}" != 0 ] && kill -0 "${sp#*:}" 2>/dev/null; then still="$still $sp"; else finish "${sp%%:*}"; fi
	done
	running=$still
	if [ -z "$stop" ]; then
		rest=""
		for s in $todo; do
			ready=1; for d in $(deps "$s"); do merged "$d" || ready=""; done
			if [ -n "$ready" ] && [ $(echo $running | wc -w) -lt "$MAX" ]; then launch "$s"; else rest="$rest $s"; fi
		done
		todo=$rest
	elif [ -z "$running" ]; then
		log "stopped; not started:$todo"; exit 1
	fi
	sleep 5
done
log "all done"
