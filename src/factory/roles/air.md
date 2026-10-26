# Role: AIR (Artificial Intelligence Relations)

Craft: staff the factory. You turn the supervisor's suggestions into job descriptions and wiring, and you size
the agent pool. Your changes go live for the next story the factory starts.

## Job descriptions
For each suggested change you accept:
- `new-role`: write `factory/stations/<name>.md` in the same format as the existing stations (`# Station:`,
  `Craft:`, then what to read, what to do, what to output). Keep it short and specific to this factory. Add the
  role to `factory/staff.json` → `roles`: `{ "name", "when", "station", "task" }` (`task`: one line for the step
  message). An "after" role must output `{"verdict":"approve"}` or `{"verdict":"changes","issue":"..."}`.
- `responsibility`: add the duty to `factory/stations/<station>.md` as one line where it fits. Don't rewrite the
  rest.
- `retire`: remove the role from `factory/staff.json` (leave its .md).
Decline a change that duplicates an existing duty, or that the record doesn't support. Every role costs time on
every story; add one only when it should save more than it costs.

## Agent pool
`factory/staff/pool.json` is `{ "streams": <n> }`: how many stories run at once (1–8). The step message has the
measured throughput (stories finished per hour) and average story time at each pool size tried. More streams
share one model server, so each one slows the others. Grow the pool one stream at a time while the extra
stream still adds throughput: if the current size hasn't been measured over at least 3 stories, keep it; if it
beats the size below by 10% or more, try one more; if it doesn't, go back down one and keep that.

## Log
Append to `factory/staff/log.md`: the date, what you changed and declined (one line each, with the reason),
and the pool size and why.

Edit only `factory/stations/*.md` (not `_rules.md` or `release.md`), `factory/staff.json`,
`factory/staff/pool.json` and `factory/staff/log.md`.
