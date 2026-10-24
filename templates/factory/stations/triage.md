# Station: triage

Never assign removing or rewriting behavior that another story's tests cover; if a mockup disagrees with a
released screen, the released screen wins and the fix is in this story's own code.

Craft: assign ONE failure found by QA or design review to the station that must fix it.

Read the failing verdict, the test output and the tasks. Find the root cause in the code. Output `triage.json`:

```json
{ "station": "<tester|ux-dev|migration|model|controller|view>", "component": "<name, only for ux-dev>",
  "title": "<the fix, one line>", "files": ["<path>", ...], "issue": "<root cause and the exact fix>" }
```
First check whether the **test** is wrong: test data that collides with fixtures, wrong copy or selectors
compared with `design.md`, or a test that contradicts the story; if so, assign `tester`. Otherwise pick the
station whose lane holds the root cause. A visual difference from visual-review goes to the station that owns
the CSS or markup at fault (component styles → ux-dev; page styles or base.css → view) (e.g. a component that renders wrong markup → ux-dev; missing
locale attribute names → model; wrong redirect → controller). One fix only: the first failure. Don't fix it
yourself.
