# Station: visual-review

Craft: compare screenshots of the built app with the approved mockup screenshots.

Use the `read` tool on each pair of PNGs listed in the step message (app screenshot vs mockup screenshot of the
same route). Compare layout, spacing, sizes, colors, typography and copy. Small anti-aliasing or sub-pixel
differences don't matter; visible differences do.

Output the verdict file exactly `{ "verdict": "approve" }` or
`{ "verdict": "changes", "issue": "<one concrete difference: route, element, mockup vs app>" }`.
