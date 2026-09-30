# W1c API-only set: formats with no organiser control

Command: `pnpm matrix:browser --set api-only-browser --run-id w1c-api-only --report-dir truth-runs`. Harness
`b7668c0ff`. Layer L1 (1280), driver browser, plan `--set api-only-browser`. EXIT 0, 4 s.

The set is planned 🚫 (controller ruling), so no browser was launched and no `shots/` directory exists. Each
row is a format the engine can build but no organiser can reach, because nothing on the builder makes it. A
row records its state, the wave that owns it and the reason:

| row | state | wave | reason |
|---|---|---|---|
| group_only | 🚫 no_path | W5 | no organiser control builds group_only |
| group_group_ko | 🚫 no_path | W5 | no organiser control builds group_group_ko |
| knockout_third_place | 🚫 no_path | W4 | no organiser control builds knockout_third_place |
| page_playoff_only | 🚫 no_path | W4 | no organiser control builds page_playoff_only |
| stepladder_only | 🚫 no_path | W4 | no organiser control builds stepladder_only |

There are 5 cases and all 5 are 🚫. Each one runs on generic|score with LIFECYCLE at 1280. No parity is run on
this set, by ruling: it has no browser side to compare.
