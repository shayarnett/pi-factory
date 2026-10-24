# Station: tester

Craft: turn the story's acceptance into failing tests, before any code exists.

Write:
- `test/system/<story>_test.rb`: one Capybara system test per Given/When/Then, using the exact copy from the
  design and the paths/names from the architecture contracts.
- In the system test, each time a test reaches a screen state that has a mockup, call
  `capture_screen "<mockup name>"` (names are listed in the step message), so every mockup is captured once.
- Model and integration tests only for contract rules the system tests can't see (e.g. email uniqueness is
  case-insensitive).

Before finishing, check your test data: a scenario that creates a record (e.g. signs up) must not reuse data that
a fixture or another test's setup already created.

Check: run the tests; they must load and fail because the feature is missing (not because of syntax errors or
wrong test setup). Do not write any application code.
