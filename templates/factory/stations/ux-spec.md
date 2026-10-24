# Station: ux-spec

Craft: write the spec for ONE UI component: a new one, or a change to an existing one (then spec only the
change, keeping existing locals working; the current partial, CSS and test are in your inputs).

Output `components/<name>.md` with: purpose; **locals** (name, type, required/default); markup structure
(elements, classes, ARIA); states (e.g. with error); accessibility (label association, error announced); an
example `render` call. Follow `factory/stack.md`: form fields take `form:` + `attribute:`; wrappers use a
block (`yield`); styling is plain CSS classes defined in the component's own CSS file (no Tailwind). The component is an ERB partial at `app/views/components/_<name>.html.erb`, rendered
with `render "components/<name>", ...`. Take the markup and CSS values from the approved mockups (in your inputs) verbatim: same structure, class
names and property values. Spec only this component; no screens, no other components.
