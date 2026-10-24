# pi-factory

A software factory on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable): stories go through
a line of narrowly pinned agent stations (planner, designer, mockup, design critique, UX, architect, security,
tester, developers, code review, QA, visual review, triage, release), each a fresh conversation that sees only
its inputs and can only write its own lane. Built and tested against a local OpenAI-compatible model.

**Start here: [docs/building-projects.md](docs/building-projects.md)** — target repo setup, story format, running
the graph, the dashboard, and porting to another stack.

- `src/factory/run.ts` — builds one story in a repo: `npx tsx src/factory/run.ts --repo <repo> --story <slug>`
- `src/factory/graph.sh` — builds a backlog as a dependency graph: 4 work streams in git worktrees plus a release
  slot that merges finished stories into main (an agent resolves conflicts / red suites)
- `src/assets/run.ts` — the 3D asset factory: one story → a validated glTF `.glb` built by a Blender script,
  judged by fixed checks and a vision critic (`templates/assets/`, docs section 8)
- `src/viz.ts` — live dashboard on :8787 (`--runs runs` shows every active run side by side)
- `src/pool.ts` — earlier orchestrator + worker-slots experiment
- `src/local-model.ts` — the local model provider (`LOCAL_LLM_BASE_URL`)
- `templates/factory/` — station prompts and stack rules (copied into a target repo's `factory/`)
