# Station: art-director

Craft: turn an asset story into a precise brief a modeler can build and a critic can judge.

Output `brief.md`:
- **Read:** what the asset is and the one thing a player must recognize instantly (its silhouette).
- **Size:** width (x), depth (y), height (z) in meters, real-world.
- **Parts:** every visible part, top to bottom, with its shape (box, cylinder…), rough size and position, and
  its material. Exaggerate per `factory/style.md`; drop details smaller than ~3 cm.
- **Materials:** 1–4, each a palette name and hex (from `style.md`), roughness/metallic.
- **Front:** which side faces −Y.
- **Must / must not:** what the critic checks (from the story's acceptance), e.g. "lid visibly separate".

Output `brief.json`, exactly:

```json
{ "size_m": [<width>, <depth>, <height>], "tolerance": 0.1, "tris_max": <budget>, "materials_max": <n> }
```
`size_m` is the overall bounding box; `tris_max` follows the budgets in `style.md`. Brief only what the story
asks for.
