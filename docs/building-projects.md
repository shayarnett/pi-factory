# Building a project with the factory

The factory builds a backlog of small stories in a target git repo. Each story goes through a line of pinned
stations; every station is a fresh agent conversation that sees only its inputs, may write only its lane, and is
done when its output exists and its check passes. Handoffs are files under `factory/stories/<story>/`, and
`git log` is the audit trail (each commit is authored by the station that made it).

This guide covers what the target repo needs, how to write stories the factory builds well, and how to run and
watch it.

## 1. Requirements

- **The stack the runner assumes:** Rails 8 + Minitest + Capybara/Selenium in headless Chrome, SQLite,
  importmap + Stimulus, plain CSS (Propshaft). Section 7 lists what to change for another stack.
- **mise** for the Ruby toolchain. The runner runs every command under `mise env -C <repo>`, so the repo needs a
  `.mise.toml`.
- **Google Chrome** at `/Applications/Google Chrome.app`, used for mockup screenshots. To change it, edit
  `CHROME` in `src/factory/run.ts`.
- **A model:** any OpenAI-compatible endpoint. Set `LOCAL_LLM_BASE_URL` (default in `src/local-model.ts`).
  - Vision is needed for design critique and visual review.
  - Every step uses thinking level "low".
  - `graph.sh` runs up to `MAX` (default 4) stories at once, plus a release step, so the server needs that many
    parallel slots.
- **The `pi` CLI** on PATH, configured for the same model. The release station runs through it.
- The repo is on branch `main`, with a clean working tree.

## 2. Target repo setup

```
<repo>/
  .mise.toml
  test/application_system_test_case.rb   # with capture_screen (below)
  factory/
    README.md          # optional, for humans
    stations/          # copy from templates/factory/stations/
    stack.md           # stack facts every station reads first (start from templates/factory/stack.md)
    components.md      # UI component registry (start with a title and one sentence; ux-dev appends entries)
    backlog.md         # optional: expected path per story, used only to score the planner
    stories/<slug>/story.md
```

**System test helper:** the visual review pairs app screenshots with mockups of the same name. The tester calls
`capture_screen("<mockup-name>")` at each screen state, and the helper must exist:

```ruby
class ApplicationSystemTestCase < ActionDispatch::SystemTestCase
  driven_by :selenium, using: :headless_chrome, screen_size: [ 1300, 900 ]

  def capture_screen(name)
    dir = ENV["FACTORY_SHOTS"] or return
    FileUtils.mkdir_p(dir)
    page.save_screenshot(File.join(dir, "#{name}.png"))
  end
end
```

**A baseline:** commit the setup, then tag it so `reset.sh` has a fallback:
`git tag factory-base`. The first story's start is also tagged automatically, as `start/<story>`.

**`stack.md` is the main lever.** Every station reads it before anything else. Almost every fix in our runs was
one line in `stack.md`, written as a fact or rule with a concrete example. Rules that paid off:
- no CSS framework (models will otherwise write Tailwind classes that do nothing);
- the form-builder convention for field components;
- `novalidate` forms;
- locale attribute names and custom `message:` for exact error copy;
- test data must not collide;
- external redirects are tested in integration tests, never system tests;
- clipboard stubbing in headless Chrome;
- generated migration timestamps.

When a run fails, the habit is: read the audit, find the fact the station was missing, and add it to
`stack.md`.

## 3. Writing stories

One folder per story: `factory/stories/<slug>/story.md`. Keep each story to **1–2 points**: one screen or one
behavior. This format is what the stations and `graph.sh` expect:

```markdown
# Story: Signed-in user shortens a URL

Feature: Shorten links · Points: 2 · Depends on: user-signs-up

As a signed-in user, I want to turn a long URL into a short link, so that I can share it easily.

## Acceptance
- **Given** I am signed in, **when** I open "My links", **then** I see a field labeled "Long URL" and a
  "Shorten" button, and a list of my links (empty state: "No links yet.").
- **Given** I enter text that is not an http(s) URL, **when** I press "Shorten", **then** I stay on the page and
  see "Long URL must start with http:// or https://" next to the field, with my entry kept.

## Out of scope
Following short links (separate story), copying, custom codes, editing or deleting links, stats.
```

- **`Depends on:`** takes one story slug. `graph.sh` parses it: a story starts only after that story is
  released. The first story depends on nothing; `user-signs-up` is treated as already released, so change that
  line in `graph.sh` for another project. Stories that depend on the same story run in parallel, so keep the graph
  wide: e.g. 4 stories that each depend only on sign-up fill all 4 streams.
- **Acceptance** is Given/When/Then, with **exact copy** for labels, buttons, empty states and errors. The tester
  writes assertions from it, and the designer writes copy from it.
- **Out of scope** prevents drift. The designer must leave out anything listed there entirely: no placeholder
  links, no disabled buttons.
- **Optional design input:**
  - `design-input.md`: the founders' look and copy, transcribed from a mock.
  - `design-input.png`: the mock image itself. The design critique compares mockups against it, which catches
    color and spacing misses that text can't.
  - Without either, new screens follow the existing app's style (`base.css`, layout, components).
- **Overlap is fine.** Stories that touch the same files (e.g. two features on one row component) will conflict
  at release, and the release station merges both sides. Avoid stories that contradict each other.

**`backlog.md` (optional)** has one table row per story. Its fourth column is the expected path, e.g.
``| 4 | `url-visit-is-counted` | 1 | + security; – designer, ux chain, view |``. The runner logs it next to the
planner's choice, so you can score the planner.

## 4. What a story goes through

```
planner → [designer → mockup ⇄ design-critique] → [ux-inventory → per component: ux-spec → ux-dev ⇄ ux-review]
        → architect [⇄ security] → tester → per task: developer ⇄ code-review
        → qa + visual-review → (triage → rework) ×3 → gate (full suite)
```

- The **planner** chooses the bracketed stages. Design runs for visible UI changes. UX runs for new or changed
  components. Security runs for auth, sessions, cross-user data, redirects to user input, or personal data.
- **Developer tasks** come from the architect's `tasks.json`. There are four developer stations: migration,
  model, controller and view. Each task is 1–2 points in one lane, built in dependency order.
- **Gates:** a reviewer answers approve, changes (the station retries, up to 2 times), or elsewhere (the problem
  is in another lane, so it goes to triage). A station that tries to write outside its lane also goes to triage.
- **Verification:**
  - QA checks the acceptance.
  - Visual review compares the screenshots taken inside the system test against the approved mockups.
  - The runner runs the full suite itself; a red test fails verification whatever QA says.
  - Triage assigns each failure to one station, never by removing behavior that an earlier story's tests cover.

**Lanes:** the files each station may write are in `LANES` in `run.ts`. Writes outside the lane are refused, and
anything written by bash outside it is reverted before the commit.

**Per-story outputs:**
- In the target repo, under `factory/stories/<slug>/`: `plan.json`, `design.md`, `mockups/*.html` and
  `base.css`, `gaps.json`, `components/*.md`, `architecture.md`, `tasks.json`, `qa.md`, `reviews/*.json`.
- In this repo, under `runs/<slug>/`: `audit.md` (every step, its files, check output and report),
  `steps.json`, `run.sqlite` (full conversations) and `shots/`.

## 5. Running

```sh
# one story, in place
LOCAL_LLM_BASE_URL=http://host:port/v1 npx tsx src/factory/run.ts --repo ~/myapp --story <slug>

# the whole backlog as a dependency graph: 4 streams in git worktrees (~/myapp-wt/<slug>) + release slot
REPO=~/myapp WT=~/myapp-wt src/factory/graph.sh            # every unreleased story
REPO=~/myapp WT=~/myapp-wt src/factory/graph.sh a b c      # just these

# reset one story to its start (deletes its commits and run state)
src/factory/reset.sh ~/myapp <slug>
```

`graph.sh` details:
- **Release:** a finished story's branch is merged into `main` and the full suite runs. On a conflict or a red
  suite, the release station (`pi`) may edit only the files involved. A good release is tagged `release/N` and
  `done/<slug>`.
- **Stopping:** a failed gate or release stops new starts. Running stories finish, `main` goes back to the last
  release, and the failed story's worktree or branch is kept for inspection.
- **Restarting:** a rerun adopts stories still running and releases finished, passing branches without
  rebuilding them.

**Mechanics test without a model:**
`FAKE=1 REPO=<scratch clone> WT=<dir> RUNS=<dir> src/factory/graph.sh`. Stub stations append to one shared file,
so merges conflict on purpose.

## 6. Watching

```sh
npx tsx src/viz.ts --runs runs        # http://localhost:8787 — grid of every active run, live
npx tsx src/viz.ts --run runs/<slug>  # one run
```

Each panel shows the steps, which conversation is generating, its live thinking, text and tool calls, and the
model server's slots and throughput. `/classic` is the plain dashboard; `/` is the chibi village view.
`src/pool.ts` is the earlier orchestrator-and-slots experiment, and `npx tsx src/viz.ts` with no flags watches
it.

## 7. Another stack

The station prompts are mostly stack-neutral. The stack lives in `stack.md` and in these spots in `run.ts`:
- **`LANES`:** the file globs per station (`app/views/**`, `db/migrate/**`, …).
- **Checks:** `bin/rails db:migrate`, `bin/rails test <file>`, `bin/rails test test/views/components`, the full
  suite `bin/rails test && bin/rails test:system`, and the gate.
- **The system test path:** `test/system/<slug_with_underscores>_test.rb`, and `FACTORY_SHOTS` for screenshots.
- **Step inputs:** `config/routes.rb`, `db/schema.rb`, `app/views/layouts/application.html.erb`,
  `app/assets/stylesheets/base.css`, the `inventory` file listing, and component paths
  (`app/views/components/_<name>.html.erb`).
- **Developer stations:** migration, model, controller and view, also listed in the `architect` and `triage`
  prompts.

In `graph.sh`, `suite()` and the `bin/rails db:prepare` calls are Rails-specific.

## 8. The asset factory (3D, glTF)

The same graph runner and release slot also build 3D assets. `src/assets/run.ts` takes one asset story to a
validated `.glb`:

```
art-director (brief.md + brief.json: size, triangle budget, materials)
  → modeler (Blender Python build.py) ⇄ tools/check.sh (build, Khronos validator, size, tris, watertight,
                                        floating parts, origin) → renders (6 views + human-scale view)
  → art-critique (vision) ⇄ modeler … up to 5 rounds → gate
```

**Target repo:** copy `templates/assets/` into it, and run `npm i gltf-validator`.
- `factory/style.md` is the rulebook: the look, the palette, meters at real-world size, origin at the bottom
  center, and triangle budgets.
- `tools/` holds the fixed checks and renders. Stations can't edit them, so no station grades its own work.
- Stories go in `factory/stories/<slug>/story.md`. Add an optional `reference.png` and both the art director and
  the critic read it.

**Requirements:** Blender on PATH (tested with 5.2) and Node.

**Run the whole backlog:**

```sh
RUNNER=src/assets/run.ts SUITE=tools/check-all.sh SETUP='ln -s ~/props/node_modules node_modules' ROOTS= \
  REPO=~/props WT=~/props-wt src/factory/graph.sh
```

Add `node_modules` to `.git/info/exclude` (not just `.gitignore` with a trailing slash), so the worktrees'
symlink isn't cleaned up as an out-of-lane file.
