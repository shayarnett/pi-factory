#!/usr/bin/env bash
# Resets a factory repo to the story's start/<story> tag (else factory-base) and deletes the story's run state.
set -euo pipefail
REPO="$1"; STORY="$2"
BASE=$(git -C "$REPO" rev-parse -q --verify "refs/tags/start/$STORY" >/dev/null && echo "start/$STORY" || echo factory-base)
git -C "$REPO" reset -q --hard "$BASE"
git -C "$REPO" clean -qfd
rm -f "$REPO"/db/*.sqlite3
rm -rf "$(dirname "$0")/../../runs/$STORY"
(cd "$REPO" && eval "$(mise env -C "$REPO" -s bash)" && bin/rails db:prepare >/dev/null 2>&1)
echo "reset $REPO to $(git -C "$REPO" rev-parse --short HEAD); cleared runs/$STORY"
