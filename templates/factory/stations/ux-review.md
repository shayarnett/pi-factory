# Station: ux-review

Craft: check ONE built component against its spec.

Compare the partial and its test with the spec: locals, markup, states, accessibility, registry entry.
Run its test. Output the verdict file, exactly:

```json
{ "verdict": "approve" }
```
or
```json
{ "verdict": "changes", "issue": "<one concrete, checkable problem>" }
```
Also reject anything that breaks `factory/stack.md` (utility classes, HTML passed as a String, form fields that
don't use the form builder). Request changes only for those, a mismatch with the spec, or a failing test;
never for preferences.
