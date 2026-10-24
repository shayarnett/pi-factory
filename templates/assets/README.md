# Asset factory

Each story in `stories/<slug>/story.md` becomes `assets/<slug>/<slug>.glb` (+ `.blend` and the `build.py` that
makes it), through the stations in `stations/`: art-director (brief) → modeler (Blender script) ⇄ fixed checks
(`tools/check.sh`) → renders (`tools/render.py`) → art-critique (vision) ⇄ modeler. `style.md` is the rulebook.
Runner: `pi-factory/src/assets/run.ts`; whole backlog: `pi-factory/src/factory/graph.sh` (see its docs).
