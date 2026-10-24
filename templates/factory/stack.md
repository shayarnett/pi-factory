# Stack facts (read before writing anything)

- Rails 8.1, Ruby 3.4, SQLite, Propshaft + importmap. **No CSS framework: no Tailwind, no Bootstrap.**
  Utility classes like `flex`, `px-6`, `text-[#123]` do nothing here.
- Visual source of truth: the approved mockups in `factory/stories/<story>/mockups/` (HTML + `base.css`). Copy their
  markup structure, class names and CSS values; don't restyle.
- Styles are plain CSS. Each component's styles live in `app/assets/stylesheets/components/<name>.css` using
  classes prefixed with the component name (e.g. `.text-field__input`). Every file in `app/assets/stylesheets/`
  is loaded automatically by the layout. Page styles go in `app/assets/stylesheets/<page>.css`.
- UI components are ERB partials in `app/views/components/`, rendered with `render "components/<name>", ...`.
  - **Form fields take a Rails form builder**: locals `form:` (the `form_with` builder) and `attribute:` (Symbol).
    Use `form.label`, `form.text_field`/`email_field`/`password_field`, so `name`, `id` and `value` come from
    Rails (`user[email]`, `user_email`). Read errors with `form.object.errors.full_messages_for(attribute)`.
  - **Slots use blocks**: a component that wraps content renders it with `yield`; callers pass a block.
    Never pass HTML in a String local.
- Forms validate on the server only: `form_with ..., html: { novalidate: true }`, so the browser never blocks a
  submit and Rails' error messages are what the user sees.
- Error messages use Rails `full_messages`, so the field name in them comes from
  `config/locales/en.yml` → `en.activerecord.attributes.<model>.<attribute>`. To show "Email Address is invalid",
  set the attribute name to "Email Address" there.
- Tests: Minitest. Unit/integration: `bin/rails test`. System (Capybara, headless Chrome): `bin/rails test:system`.
  Component tests: `ActionView::TestCase` in `test/views/components/`.
- Test data must not collide: fixtures hold only records a test needs to exist beforehand, and a test that signs
  up or creates a record uses data no fixture uses (e.g. a unique email). Prefer creating setup records inside
  the test that needs them.
- **Exact error copy:** when the design gives an error message, the user must see exactly that text. Set the
  locale attribute name and, where Rails' default wording differs, a custom `message:` on the validation
  (e.g. `validates :url, format: { with: ..., message: "must start with http:// or https://" }` with attribute
  name "Long URL" gives "Long URL must start with http:// or https://").
- **Signed-in tests:** a system/integration test signs in by signing up (or via the app's sign-in path) with
  unique data; don't stub the session.
- **Browser JS:** only Stimulus controllers in `app/javascript/controllers/<name>_controller.js` (importmap,
  auto-registered by `controllers/index.js`; no npm, no bundler). Wire with `data-controller`,
  `data-action`, `data-<name>-target`. JS-dependent behavior is tested with a system test (headless Chrome runs JS).
- **Migrations:** create them with `bin/rails generate migration <Name> ...` so the filename carries the current
  timestamp; never hand-pick a version number (other stories add migrations in parallel).
- **System tests stay on the app.** Headless Chrome reaches the real internet, so a system test never follows a
  redirect to another host. Test redirects to external URLs in an integration test
  (`get "/s/abc123"; assert_redirected_to "https://example.com/x"`); `redirect_to` an external URL needs
  `allow_other_host: true`.
- **Clipboard in system tests:** headless Chrome has no clipboard permission (`clipboardRead` is rejected). Stub it
  before clicking: `page.execute_script("window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve() }")`,
  then `assert_equal expected, page.evaluate_script("window.__copied")`.
- **No status codes in system tests:** the Selenium driver has no `page.status_code` or response headers. Check
  status codes (404, 302) in integration tests; system tests check only what the user sees.
