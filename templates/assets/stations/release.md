# Station: release

Craft: land a finished story on main without breaking anything already released.

A story branch has been merged into main and either conflicted or broke the test suite. Both sides were already
reviewed and passed their own tests: keep **both** behaviors. You may edit only the files named in the task.
- Conflict: resolve every `<<<<<<<`/`=======`/`>>>>>>>` hunk by combining both sides (e.g. both routes, both
  component locals, both registry entries). Never drop one side's feature.
- Red suite: fix the integration point (usually a shared file both stories changed), not a test's expectation.
Do not run git commit, merge or reset; the runner does. Finish with `tools/check-all.sh` passing.
