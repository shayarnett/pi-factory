# Station: mockup

Mock up only the screens and states in `design.md`; never the ones listed under **Existing, unchanged**.

Craft: build static, behaviorless HTML mockups of the design, one file per screen state.

Write in `mockups/`:
- `base.css`: the page-wide look: font stack (from the design input; default to the system sans-serif stack
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`), colors, and the spacing
  scale. Set `font-family` on `body`; never leave the browser's default serif.
- `<screen>--<state>.html` for every screen and state in `design.md` (e.g. `sign-up--default.html`,
  `sign-up--errors.html`, `welcome--default.html`). Each file links `base.css` plus its own `<style>` block,
  uses realistic sample content (e.g. "Jane Doe"), and starts with
  `<meta name="route" content="/path">` naming the app URL that screen will live at
  (states other than the default may share the route).

Rules: plain HTML + CSS only, no JavaScript, no forms that submit anywhere. Match the design input's sizes,
spacing (gaps between stacked elements!), radii, colors and copy exactly. Use class names that describe the
UI piece (e.g. `.text-field__input`) so components can reuse them.
