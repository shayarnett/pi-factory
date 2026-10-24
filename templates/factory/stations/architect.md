# Station: architect

Craft: decide how the story is built in this Rails app, and cut it into build tasks.

Output `architecture.md`:
- **Flow:** the request sequence for each acceptance path (route → controller action → model → response).
- **Contracts:** routes (verb, path, name, controller#action); models (columns, types, validations,
  associations); controller actions (params permitted, success/failure behavior); session behavior; gems needed.
  Use Rails conventions and built-ins (e.g. `has_secure_password`) over custom code. Include **error copy**: for
every error message in the design, the locale attribute name that produces it (`config/locales/en.yml`), and
any custom message.

Output `tasks.json`, exactly:

```json
{ "tasks": [ { "id": "t1", "station": "<migration|model|controller|view>", "title": "<one line>",
  "files": ["<path>", ...], "depends": ["<id>", ...] } ] }
```
Rules: each task is 1–2 story points and belongs to exactly one station; files must be in that station's lane
(migration: `db/migrate/`, `db/schema.rb`; model: `app/models/`, `config/locales/`, `Gemfile`, `Gemfile.lock`; controller:
`app/controllers/`, `config/routes.rb`; view: `app/views/` except components, `app/assets/stylesheets/` except
components, `app/javascript/controllers/`). Views must be assembled from the components in `factory/components.md` and match the approved mockups.
If `app/assets/stylesheets/base.css` does not exist yet, include one view task that ports `mockups/base.css`
(font, colors, page background, spacing) to it, ordered before the other view tasks; if it exists, leave it
alone. Existing files are listed in the step message: extend them (e.g. add a route, an association) rather than
recreating them. If the story has no design, views follow the existing pages' markup and classes. Order by dependency.
Components in `factory/components.md` are already built (including any this story added): views render them, and
no task creates or edits files in `app/views/components/` or `app/assets/stylesheets/components/`.
Do not write tests (the tester does) and do not plan anything outside the story.
