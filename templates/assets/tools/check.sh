#!/usr/bin/env bash
# tools/check.sh <slug> : builds the asset, validates and measures the .glb, and checks it against the brief.
# Prints one PASS/FAIL line per check; exits 1 if any check fails.
set -u
cd "$(dirname "$0")/.."
S=$1; A=assets/$S; B=factory/stories/$S/brief.json
fail=0
say() { echo "$1 $2"; [ "$1" = FAIL ] && fail=1; return 0; }
blender -b --factory-startup --python "$A/build.py" > /tmp/build-$S.log 2>&1
if [ ! -f "$A/$S.glb" ] || grep -q "Error\|Traceback" /tmp/build-$S.log; then
	say FAIL "build: $A/build.py did not export $A/$S.glb"; grep -A8 "Traceback\|Error" /tmp/build-$S.log | head -20; exit 1
fi
say PASS "build: exported $A/$S.glb"
v=$(node tools/validate.mjs "$A/$S.glb"); echo "$v" | grep -q "errors=0" && say PASS "gltf-validator: $(echo "$v" | tail -1)" || { say FAIL "gltf-validator:"; echo "$v"; }
m=$(blender -b --factory-startup --python tools/inspect.py -- "$A/$S.glb" 2>/dev/null | grep '^INSPECT ' | cut -c9-)
echo "measured: $m"
python3 - "$m" "$B" <<'PY' || fail=1
import json, sys
m = json.loads(sys.argv[1]); b = json.load(open(sys.argv[2]))
bad = False
def check(ok, msg):
    global bad
    print(("PASS " if ok else "FAIL ") + msg); bad |= not ok
tol = b.get("tolerance", 0.1)
for axis, want, got in zip(("width", "depth", "height"), b["size_m"], m["size_m"]):
    check(abs(got - want) <= want * tol, f"{axis}: {got} m (brief {want} m ±{int(tol*100)}%)")
check(m["tris"] <= b["tris_max"], f"triangles: {m['tris']} (budget {b['tris_max']})")
check(len(m["materials"]) <= b.get("materials_max", 4), f"materials: {len(m['materials'])} {m['materials']} (max {b.get('materials_max', 4)})")
check(m["nonmanifold_edges"] == 0, f"non-manifold edges: {m['nonmanifold_edges']} (must be 0: closed, watertight mesh)")
check(not m["floating_parts"], f"floating parts: {len(m['floating_parts'])} of {m['parts']} parts touch nothing (each part must touch or overlap the part it attaches to) {m['floating_parts']}")
check(m["uvs"], "UVs present")
check(m["objects"] == 1, f"objects: {m['objects']} (must be 1)")
check(abs(m["bottom_z"]) < 0.005 and all(abs(c) < 0.005 for c in m["center_xy"]), f"origin: bottom center (bottom_z {m['bottom_z']}, center {m['center_xy']})")
sys.exit(1 if bad else 0)
PY
exit $fail
