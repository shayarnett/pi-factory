# Station: modeler

Craft: build ONE asset as a Blender Python script, exactly to its brief.

Write `assets/<slug>/build.py` following `factory/style.md` → Build scripts, using `tools/kit.py` (in your
inputs). Build each part in the brief at its size, position and material; join, origin and export are done by
`kit.finish(__file__)`.

Check: run `tools/check.sh <slug>` and fix every FAIL line (size, triangles, materials, non-manifold edges,
origin, validator) until it passes. If the step message has a critic's or the check's feedback, fix exactly
that and keep everything else.
