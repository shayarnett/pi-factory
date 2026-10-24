# Style and asset rules (read before anything else)

## Look
- **Low-poly, flat-shaded, stylized.** Readable silhouettes, chunky proportions, slight exaggeration (thicker
  rims, bigger bolts, rounder handles). No photoreal detail, no tiny parts a player can't see at 5 m.
- **Color, not texture:** each material is one flat color (Principled BSDF base color + roughness/metallic).
  No image textures. Each asset uses 1–4 materials from the palette below (or a close shade, stated in the brief).
- **Palette:** wood `#9c6b3c` / dark wood `#5e3d22` · iron `#4a4f57` (metallic 0.6, roughness 0.5) · brass
  `#c9a227` (metallic 0.8) · stone `#9a9a92` · leaf green `#5f9e4b` · cloth red `#b8423a` · cloth cream
  `#e8dcc0` · glass/glow `#ffd46b` (lamp glass) · rope `#c2a46b`.
- Bevels are modelled as geometry (an inset band, a chamfered edge), never smoothing.

## Technical (checked by `tools/check.sh`; a FAIL blocks the asset)
- Units are **meters**, at real-world size (a crate ≈ 0.6 m, a barrel ≈ 0.9 m tall, a door ≈ 2 m).
- One object, closed and watertight (0 non-manifold edges): every part is a closed primitive or closed mesh.
  Parts may overlap/intersect; never leave open faces (no lone planes, no deleted caps).
- Origin at the **bottom center**; the asset stands on z = 0 and faces **−Y** (its front looks toward the front
  camera). `kit.finish()` does the origin, grounding, join, UVs and export.
- Triangle budget from the brief (props: small ≤ 300, medium ≤ 800, large ≤ 1500).
- Output: `assets/<slug>/<slug>.glb` (glTF 2.0 binary, passes the Khronos validator) and `<slug>.blend`.

## Build scripts
- `assets/<slug>/build.py` is a Blender Python script run headless: `blender -b --factory-startup --python
  assets/<slug>/build.py`. It must start with the two-line `kit` import from `tools/kit.py` and end with
  `kit.finish(__file__)`.
- Build from `kit` primitives (`box`, `cylinder`, `cone`, `sphere`, `torus`), positioned and rotated; use
  `bmesh` only for shapes primitives can't make. Low segment counts (cylinders 8–16 sides).
- Rotations are radians (`math.radians(90)`). Blender is Z-up: height is z, width x, depth y.
- Check your own work by running `tools/check.sh <slug>` (it builds, validates and measures).
