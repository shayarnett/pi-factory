#!/usr/bin/env bash
# Runs stories as a dependency graph: up to MAX work streams (one story each, in its own git worktree), plus one
# release slot that lands finished stories on main one at a time.
# A story starts when every story it "Depends on:" is released. Release: merge the story branch into main, run the
# full suite; on a conflict or a red suite the release station (pi agent) fixes only the files involved. A failed
# gate or release stops new starts; main is put back to the last release.
#
#   src/factory/graph.sh [story ...]   # default: every story not yet released; adopts stories already running
#   RUNNER=src/assets/run.ts SUITE=tools/check-all.sh SETUP='ln -s $REPO/node_modules node_modules' ROOTS= \
#     REPO=~/props WT=~/props-wt src/factory/graph.sh                # the asset factory
#   FAKE=1 REPO=<clone> WT=<dir> RUNS=<dir> src/factory/graph.sh   # stub stations, to test the mechanics
cd "$(dirname "$0")/../.."
PI=$PWD
REPO=${REPO:-~/acme}
WT=${WT:-~/acme-wt}
RUNS=${RUNS:-$PI/runs}
MAX=${MAX:-4}
RUNNER=${RUNNER:-src/factory/run.ts}
SUITE=${SUITE:-"bin/rails db:prepare >/dev/null && bin/rails test && bin/rails test:system"}
SETUP=${SETUP:-"bin/rails db:prepare >/dev/null"}
ROOTS=${ROOTS-user-signs-up} # stories treated as released without a done/ tag
# FOREVER=1: never exit; rescan for new stories, skip failures (tagged failed/<story>), and when fewer than LOW
# stories are waiting run CURATE (a command; {repo} becomes worktree $WT/_curate on branch curate) and merge it.
FOREVER=${FOREVER-}
LOW=${LOW:-3}
CURATE=${CURATE-}
# STAFF (default on; STAFF= turns it off): after every 3 finished stories, src/factory/supervise.sh (supervisor +
# HR) runs in worktree $WT/_staff on branch staff and is merged like the curator. HR sets the pool size in
# factory/staff/pool.json ({"streams": n}), which overrides MAX and is reread every loop.
STAFF=${STAFF-1}
export LOCAL_LLM_BASE_URL=http://127.0.0.1:18888/v1
mise_env() { eval "$(mise env -C "$1" -s bash)"; }
log() { echo "$(date +%T) $*"; }

cd "$REPO" || exit 1
[ "$(git branch --show-current)" = main ] || { log "$REPO must be on main"; exit 1; }
merged() { case " $ROOTS " in *" $1 "*) return 0 ;; esac; git merge-base --is-ancestor "refs/tags/done/$1" main 2>/dev/null; }
deps() { grep -o 'Depends on: [a-z0-9-]*' "$REPO/factory/stories/$1/story.md" | sed 's/Depends on: //'; }
suite() { [ -n "$FAKE" ] || (mise_env "$REPO" && eval "$SUITE" >"$1" 2>&1); }
gate_ok() { grep -q "^- gate: pass" "$1" 2>/dev/null || { grep -q "bin/rails test: pass" "$1" && grep -q "bin/rails test:system: pass" "$1"; } 2>/dev/null; }

todo=""
running="" # "story:pid" pairs
failed() { git rev-parse -q --verify "refs/tags/failed/$1" >/dev/null; }
for s in ${@:-$(ls factory/stories)}; do
	merged "$s" && continue
	[ -n "$FOREVER" ] && failed "$s" && continue
	pid=$(pgrep -o -f "run.ts --repo $WT/$s --story $s")
	if [ -n "$pid" ]; then running="$running $s:$pid"; log "adopt $s (pid $pid)"
	elif git rev-parse -q --verify "story/$s" >/dev/null && ! git merge-base --is-ancestor "story/$s" main && gate_ok "$RUNS/$s/audit.md"; then
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
	(cd "$dir" && { [ -f .mise.toml ] && mise trust -q .; mise_env "$dir"; eval "$SETUP"; } >/dev/null 2>&1)
	log "start $s"
	echo "$(date +%s) $(( $(echo $running | wc -w) + 1 ))" > "$RUNS/$s.started"
	if [ -n "$FAKE" ]; then
		(sleep $((RANDOM % 5 + 2)); cd "$dir" && echo "<!-- $s -->" >> app/views/home/index.html.erb && echo "/* $s */" >> app/assets/stylesheets/home.css && git add -A &&
			git -c user.name=fake -c user.email=f@x commit -qm "[fake] $s" && mkdir -p "$RUNS/$s" &&
			printf -- '- bin/rails test: pass\n- bin/rails test:system: pass\n' > "$RUNS/$s/audit.md") &
	else
		(cd "$PI" && npx tsx "$RUNNER" --repo "$dir" --story "$s" > "$RUNS/$s.log" 2>&1) &
	fi
	running="$running $s:$!"
}

# Release station: the pi agent, allowed to change only $files; anything else it touches is reverted.
release_fix() {
	local s=$1 why=$2 files out=$RUNS/release-$s.log
	files=$(echo $3) # one line, space-separated
	[ -n "$files" ] || { log "release station: $why in $s, but no files to fix"; return; }
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

fail_story() { if [ -n "$FOREVER" ]; then git tag -f "failed/$1" "story/$1" >/dev/null 2>&1; else stop=1; fi; }

# Curator: runs in its own worktree; its new stories are merged into main by the loop, between releases.
curating=0
curate_tick() {
	if [ "$curating" != 0 ]; then
		kill -0 "$curating" 2>/dev/null && return
		curating=0
		if git merge -q --no-edit curate >/dev/null 2>&1; then log "curated: $(git diff --name-only HEAD@{1} HEAD -- factory/stories | cut -d/ -f3 | sort -u | tr '\n' ' ')"
		else git merge --abort 2>/dev/null; log "curate merge failed"; fi
		return
	fi
	local waiting=$(echo $todo | wc -w)
	[ "$waiting" -lt "$LOW" ] || return
	git worktree remove --force "$WT/_curate" 2>/dev/null
	git worktree add -q -B curate "$WT/_curate" main
	log "curate (waiting: $waiting)"
	(cd "$PI" && eval "${CURATE//\{repo\}/$WT/_curate}" > "$RUNS/curate-$(date +%s).log" 2>&1) &
	curating=$!
}

# Every finished story goes in $RUNS/finished.tsv: end start story pass|fail streams (for the supervisor and HR).
finish() {
	local r=fail; release "$1"
	git merge-base --is-ancestor "refs/tags/done/$1" HEAD 2>/dev/null && r=pass
	echo "$(date +%s) $(cut -d' ' -f1 "$RUNS/$1.started" 2>/dev/null || date +%s) $1 $r $(cut -d' ' -f2 "$RUNS/$1.started" 2>/dev/null || echo $MAX)" >> "$RUNS/finished.tsv"
	since=$((since + 1)); recent="$recent $1"
}

release() {
	local s=$1 a=$RUNS/$1/audit.md base
	if ! gate_ok "$a"; then
		log "FAIL gate $s (worktree kept: $WT/$s)"; fail_story "$s"; return
	fi
	base=$(git rev-parse HEAD)
	if ! git merge -q --no-ff --no-commit "story/$s" >/dev/null 2>&1; then
		local conflicted=$(echo $(git diff --name-only --diff-filter=U))
		release_fix "$s" "it conflicted" "$conflicted"
		if [ -z "$conflicted" ] || git diff --name-only --diff-filter=U | grep -q . || grep -l '^<<<<<<<\|^>>>>>>>' $conflicted </dev/null >/dev/null 2>&1; then
			git merge --abort; log "FAIL release $s: conflict not resolved (branch story/$s kept)"; fail_story "$s"; return
		fi
		git add -- $conflicted
	fi
	git -c user.name=release -c user.email=release@factory.local commit -qm "release: $s" --no-edit
	if ! suite "$RUNS/release-$s.suite"; then
		release_fix "$s" "the full suite failed after the merge" "$(git diff --name-only "$base" HEAD)"
		git diff --cached --quiet || git -c user.name=release -c user.email=release@factory.local commit -qm "release: fix $s integration"
		if ! suite "$RUNS/release-$s.suite"; then
			git reset -q --hard "$base"; log "FAIL release $s: suite still red, main reset (branch story/$s kept)"; fail_story "$s"; return
		fi
	fi
	local n=$(( $(git tag -l 'release/*' | wc -l) + 1 ))
	git tag -f "done/$s" HEAD >/dev/null
	git tag "release/$n" HEAD
	git worktree remove --force "$WT/$s" 2>/dev/null
	log "RELEASE $n: $s"
}

# Supervisor + HR: after every 3 finished stories, in their own worktree; merged between releases.
staffing=0 since=0 recent=""
staff_tick() {
	if [ "$staffing" != 0 ]; then
		kill -0 "$staffing" 2>/dev/null && return
		staffing=0
		if git merge -q --no-edit staff >/dev/null 2>&1; then log "staff: $(git diff --name-only HEAD@{1} HEAD -- factory | tr '\n' ' ')"
		else git merge --abort 2>/dev/null; log "staff merge failed"; fi
		return
	fi
	[ "$since" -ge 3 ] || return
	local three=$(echo $recent | tr ' ' '\n' | tail -3 | tr '\n' ' ')
	since=0 recent=""
	git worktree remove --force "$WT/_staff" 2>/dev/null
	git worktree add -q -B staff "$WT/_staff" main
	log "supervise: $three"
	(cd "$PI" && src/factory/supervise.sh "$WT/_staff" "$RUNS" $three > "$RUNS/staff-$(date +%s).log" 2>&1) &
	staffing=$!
}
pool_size() { local n; n=$(jq -r '.streams // empty' factory/staff/pool.json 2>/dev/null); [ -n "$n" ] && [ "$n" -ge 1 ] && [ "$n" -le 8 ] && echo "$n" || echo "$MAX0"; }
MAX0=$MAX

while [ -n "$todo$running$FOREVER" ]; do
	n=$(pool_size); [ "$n" != "$MAX" ] && log "pool: $MAX → $n streams" && MAX=$n
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
		if [ -n "$FOREVER" ]; then
			[ -n "$CURATE" ] && curate_tick
			[ -n "$STAFF" ] && [ -z "$FAKE" ] && staff_tick
			for s in $(ls factory/stories); do
				merged "$s" || failed "$s" || case " $todo $running " in *" $s "* | *" $s:"*) ;; *) todo="$todo $s"; log "new: $s" ;; esac
			done
		fi
	elif [ -z "$running" ]; then
		log "stopped; not started:$todo"; exit 1
	fi
	sleep 5
done
log "all done"
