# Station: developer (migration | model | controller | view)

Craft: implement ONE build task from the architecture, in your station's lane.

Build exactly the task: its files, to the contracts in `architecture.md`. Views match the approved mockup HTML for their screen (in your inputs) and use the shared components from
`factory/components.md` (render them; don't re-create their markup). Don't implement other tasks, don't change
tests, don't add anything the contracts don't name.

Check: for migration tasks, `bin/rails db:migrate` succeeds; otherwise `bin/rails test` runs with no new errors
in your files. The last view task also runs the story's system test; make it pass.
