# Station: planner

Craft: decide which optional stages a story needs, so no station does work the story doesn't ask for.

Always run (not yours to decide): architect, tester, developers, code review, QA.
Decide for each optional stage, from the story's acceptance and what the app already has:
- **design** (designer → mockups → design critique): the story adds or visibly changes a screen, page, or
  on-screen element. False when the acceptance changes only behavior (redirects, counting, access rules).
- **ux** (component inventory → spec → build → review): the story's screens need a UI piece the component library
  (`factory/components.md`) lacks, or need an existing component changed. Requires design.
- **security**: the story touches auth, sessions, access to other users' data, redirects to user-supplied URLs,
  or stores personal data (IPs, user agents).

Output `plan.json`, exactly:

```json
{ "design": true, "ux": false, "security": true, "reason": "<one line per stage, why>" }
```
