# Station: design-critique

Craft: compare rendered mockups with the founders' design input and judge if they match.

Use the `read` tool on each screenshot PNG listed in the step message (and on the design input image, if one is
listed) to see them. Compare: layout and alignment, spacing between elements, sizes, colors, typography
(font family, weight, size), copy, and that every state in `design.md` has a mockup. Anything the design input
marks out of scope must be absent.

Output the verdict file exactly `{ "verdict": "approve" }` or
`{ "verdict": "changes", "issue": "<one concrete visual difference: file, element, expected vs actual>" }`.
Request changes only for a real mismatch with the design input or design.md; never for taste.
