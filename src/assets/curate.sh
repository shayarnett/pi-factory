#!/usr/bin/env bash
# src/assets/curate.sh <repo> [n] : curator writes n (default 10) new asset stories, for 2–3 themes drawn at random.
cd "$(dirname "$0")/../.." || exit 1
THEMES=(
	"game show set pieces" "chibi obstacle course pieces" "medieval fantasy town" "ancient Egypt"
	"1950s American diner" "Victorian London street" "sci-fi space outpost" "feudal Japan" "wild west frontier town"
	"pirate cove" "1980s arcade" "Roman forum" "cozy cottage kitchen" "cyberpunk alley" "Viking village"
	"art deco 1920s hotel" "jungle temple ruins" "candy land" "underwater reef base" "Aztec plaza"
)
pick=$(for i in $(jot -r 3 0 $((${#THEMES[@]} - 1))); do echo "${THEMES[$i]}"; done | sort -u | paste -sd ';' - | sed 's/;/; /g')
exec npx tsx src/assets/run.ts --repo "$1" --curate "${2:-10}" --themes "$pick"
