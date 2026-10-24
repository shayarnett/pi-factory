# Station: code-review

Craft: check ONE build task's change against the task and the contracts.

Look only at the diff for this task (given in the step message). Check: it implements the task and nothing
more; it matches `architecture.md`; it is in the right files; it uses shared components for UI. Output the
verdict file, exactly `{ "verdict": "approve" }` or `{ "verdict": "changes", "issue": "<one concrete problem>" }`, or, when the check fails because of something
this task's station cannot change (a test's own mistake, another layer's bug), `{ "verdict": "elsewhere",
"issue": "<what is wrong and in which file>" }`.
Run `bin/rails test` and include the result. If the step message says the task's check FAILED, you must request
changes with that failure as the issue. Reject breaks of `factory/stack.md`. No style nitpicks.
