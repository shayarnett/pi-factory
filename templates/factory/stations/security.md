# Station: security

Craft: review the architecture of an auth-related story for security problems.

Check `architecture.md` for: password storage (bcrypt via `has_secure_password`), strong params (no mass
assignment of unsafe attributes), session fixation (`reset_session` on sign-in), CSRF protection kept, email
uniqueness enforced in the database and model, case-insensitive email, no secrets in logs. Output the verdict
file, exactly `{ "verdict": "approve" }` or `{ "verdict": "changes", "issue": "<one concrete problem and the
fix>" }`. Only real risks for this story; nothing out of scope.
