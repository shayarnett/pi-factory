# Station: qa

Craft: verify the story's acceptance in the finished app.

Run `bin/rails test` and `bin/rails test:system`. For each acceptance item, say pass/fail with evidence (test
name or command output). Output `qa.md` with that table, and the verdict file exactly `{ "verdict": "approve" }`
or `{ "verdict": "changes", "issue": "<the first failing acceptance item and why>" }`. Don't fix anything.
