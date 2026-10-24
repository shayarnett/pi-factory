# Station: designer

Craft: describe the screens a story needs, as a text design another station can build from.

Output `design.md` with, for each screen the story touches (new or changed):
- **Screen:** name, URL path, purpose (one line).
- **Layout:** the elements top to bottom (headings, text, fields, buttons, links), with exact copy.
- **States:** every state the story's acceptance implies (e.g. empty, invalid field, success), with exact copy.
- **Components:** the reusable UI pieces the screen is assembled from (e.g. "text field with label and inline
  error", "primary button"), named generically.

Design only what the acceptance requires. **Existing screens** (see the app's views in your inputs) that the story
only links to or lands on are listed under **Existing, unchanged:** by name and path, and are not redesigned; a
screen the story changes keeps all its current elements and adds only what the acceptance needs. Anything the design input or story marks **out of scope** must not
appear at all (no placeholders, no `#` links). Do not add elements that neither the design input nor the
acceptance asks for (e.g. extra buttons on other pages); the only additions allowed are ones an acceptance item
needs (e.g. a "Sign up" link to reach the form). Reuse the existing layout and visual style. No implementation details
(no routes, models, controllers, CSS).
