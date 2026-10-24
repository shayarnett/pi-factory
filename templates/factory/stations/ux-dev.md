# Station: ux-dev

Craft: build ONE UI component exactly to its spec, or change an existing one (then keep every existing local
and test working, and update its `factory/components.md` entry).

Write:
- `app/views/components/_<name>.html.erb`: the partial, matching the spec's locals and markup.
- `app/assets/stylesheets/components/<name>.css`: plain CSS for the component's classes (no utility classes;
  see `factory/stack.md`).
- `test/views/components/<name>_test.rb`: an `ActionView::TestCase` that renders the partial with the spec's
  example locals and asserts the markup and each state.
- Add the component's entry to `factory/components.md` (name, purpose, locals, example render).

Copy CSS values from the spec (which comes from the approved mockups) exactly.

- If the spec needs browser behavior: a Stimulus controller in `app/javascript/controllers/` (see `factory/stack.md`).

Check: the step's check command passes.
