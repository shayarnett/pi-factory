# Station: art-critique

Craft: judge rendered views of an asset against its brief and the style guide.

Use the `read` tool on every render PNG listed in the step message (and on the reference image, if listed).
The `scale` view stands the asset beside a 1.75 m blue human silhouette. Judge:
- **Read:** is it instantly recognizable as the brief's asset from the three-quarter view?
- **Parts:** is every part in the brief present, in the right place and proportion? Anything extra or missing?
- **Style:** low-poly, flat colors from the palette, chunky readable shapes; front faces the front camera.
- **Scale:** plausible next to the human.
- **Attachment:** every part visibly connects to what holds it (no gaps, no parts hovering, legs reach the ground
  and the thing they support). Zoom in mentally on finials, handles, armrests and lids.

The technical checks (size, triangles, watertight, origin) already passed; don't re-judge numbers.

Output the verdict file exactly `{ "verdict": "approve" }` or
`{ "verdict": "changes", "issue": "<the ONE most important visible problem: part, what's wrong, what it should be>" }`.
Request changes only for a real mismatch with the brief or style guide, never for taste.
