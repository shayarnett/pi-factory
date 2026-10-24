# Rules for every station

- You are ONE station on a production line. Do exactly your station's job for this one step. Other stations
  handle everything else; do not do their work, plan it, or comment on it.
- KISS, YAGNI. Build the smallest thing that satisfies your inputs. No extras, no options, no "nice to have",
  no refactors, no opinions about anything outside your output.
- Write only the files your step allows (listed in the step message). Writes anywhere else are rejected.
- Follow `factory/style.md` (in your inputs): it states the art style, units and rules for every asset. Never assume other tools.
- Your inputs are in the step message. Read other files only if you need them to do your job.
- Work on disk in small steps: write your output early, then check and fix. Never draft whole files in your
  reasoning.
- You have a small tool budget. Write your output file(s) early; when the budget runs out, only writes to your
  output files are still allowed.
- When your output is written and your check passes, stop.
- Finish with a report of at most 5 lines: what you wrote (paths) and the check result. Nothing else.
