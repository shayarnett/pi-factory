# Station: ux-inventory

Craft: compare a design's components with the component library and list what is missing.

Read the design's **Components** sections, the approved mockup HTML, and the library (`factory/components.md`, `app/views/components/`).
Output `gaps.json`, exactly:

```json
{ "existing": ["<library name>", ...],
  "new": [ { "name": "<snake_case>", "purpose": "<one line>" } ],
  "changed": [ { "name": "<library name>", "change": "<one line: what it must now do>" } ] }
```

A component is **new** only if the library has nothing that fits. An existing component goes in **changed**
only if the design needs it to show or do something it can't today (a new local, element, or state); prefer
changing a close fit over adding a near-duplicate. Keep the list minimal: generic, reusable
pieces only (a labeled text field, a button), never whole screens or forms.
