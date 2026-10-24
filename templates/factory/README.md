# Factory

Work is built by a fixed pipeline of **stations** (see `stations/`). Each station is an agent with one craft,
given only its inputs, allowed to write only its lane, and done when its output exists and its check passes.
Handoffs are files in `stories/<story>/`. The runner lives in `~/pi-durable/src/factory/run.ts`.

Pipeline: designer → mockup ⇄ design-critique (vision) → ux-inventory → (per new component: ux-spec → ux-dev → ux-review) → architect → security →
tester → (per task: developer station → code-review) → qa → visual-review (vision: app screenshots vs mockup screenshots), with triage → rework loops.
