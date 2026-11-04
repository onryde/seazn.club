# Matrix truth run summary

Previous complete run: 2026-10-31 (4 days ago) — run 41184503925

Harness faults in this run: 221 (L1 165, L2 56).

**Run complete: no** — L1: 165 harness faults in this run; L1: this run's merged results hold 165 harness faults; L2: 56 harness faults in this run; L2: this run's merged results hold 56 harness faults.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-41818942253-1-l1 | 8 | 229 | 166 | 1 | 0 | 165 | 0 | 0 | 63 | 0 | 0 |
| L2 | L2 (grid) | ci-41818942253-1-l2 | 2 | 1729 | 56 | 0 | 0 | 56 | 0 | 0 | 279 | 1394 | 0 |
| L3 | — | ci-41818942253-1-l3 | 2 | 930 | 930 | 835 | 0 | 95 | 0 | 0 | 0 | 0 | 0 |

## Planned ░ by atom

- L1: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
**L2** — 1394 planned ░ across 82 atoms:

| atom | planned |
|---|---|
| R11b | 21 |
| R12a | 21 |
| R12b | 21 |
| C1 | 19 |
| C2 | 19 |
| C3a | 19 |
| C3b | 19 |
| C6a | 19 |
| C6b | 19 |
| C7 | 19 |
| D3 | 19 |
| D5a | 19 |
| D5b | 19 |
| D6 | 19 |
| D7 | 19 |
| E1 | 19 |
| E3 | 19 |
| E4a | 19 |
| E4b | 19 |
| F2 | 19 |
| M10 | 19 |
| M11 | 19 |
| M12a | 19 |
| M12c | 19 |
| M2 | 19 |
| M3 | 19 |
| M4a | 19 |
| M4b | 19 |
| M6 | 19 |
| M7a | 19 |
| M7b | 19 |
| M8a | 19 |
| M8b | 19 |
| M9a | 19 |
| M9b | 19 |
| P1 | 19 |
| P3 | 19 |
| P4 | 19 |
| P5a | 19 |
| P6 | 19 |
| R1 | 19 |
| R10 | 19 |
| R11a | 19 |
| R16 | 19 |
| R2 | 19 |
| R3 | 19 |
| R4c | 19 |
| R5 | 19 |
| R7 | 19 |
| R8 | 19 |
| R9a | 19 |
| R9b | 19 |
| X1a | 19 |
| X1b | 19 |
| X3 | 19 |
| X4a | 19 |
| X4b | 19 |
| X4c | 19 |
| M12b | 17 |
| F8 | 16 |
| M5 | 15 |
| R14 | 15 |
| C4 | 12 |
| P7 | 12 |
| X2 | 12 |
| F3 | 11 |
| F4 | 11 |
| F5a | 11 |
| F5b | 11 |
| F6 | 11 |
| F7 | 11 |
| P2 | 11 |
| P5b | 11 |
| Q1a | 11 |
| Q1b | 11 |
| Q2 | 11 |
| Q3 | 11 |
| Q5a | 11 |
| Q5b | 11 |
| R15 | 11 |
| R4b | 11 |
| R6 | 11 |

- L3: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
## Harness faults

**L1** — 165 faults: harness-error 165

- [harness-error] `league|football|11-a-side|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s1-1/c/matrix-league-football-11-a-side-lifecycle never showed within 15…
- [harness-error] `league|cricket|t20|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s2-1/c/matrix-league-cricket-t20-lifecycle never showed within 15000 ms …
- [harness-error] `league|boardgame|blitz|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s3-1/c/matrix-league-boardgame-blitz-lifecycle never showed within 15000…
- [harness-error] `league|carrom|club-29|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s4-1/c/matrix-league-carrom-club-29-lifecycle never showed within 15000 …
- [harness-error] `league|generic|score|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s5-1/c/matrix-league-generic-score-lifecycle never showed within 15000 m…
- [harness-error] `league|volleyball|beach|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s6-1/c/matrix-league-volleyball-beach-lifecycle never showed within 1500…
- [harness-error] `league|badminton|bwf-3x15|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s7-1/c/matrix-league-badminton-bwf-3x15-lifecycle never showed within 15…
- [harness-error] `league|tabletennis|bo5|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s8-1/c/matrix-league-tabletennis-bo5-lifecycle never showed within 15000…
- [harness-error] `league|tennis|tour|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s1-2/c/matrix-league-tennis-tour-lifecycle never showed within 15000 ms …
- [harness-error] `league|icehockey|iihf|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s2-2/c/matrix-league-icehockey-iihf-lifecycle never showed within 15000 …
- [harness-error] `league|hockey|fih-outdoor|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s3-2/c/matrix-league-hockey-fih-outdoor-lifecycle never showed within 15…
- [harness-error] `triple_rr|football|11-a-side|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s4-2/c/matrix-triple-rr-football-11-a-side-lifecycle never showed within…
- [harness-error] `triple_rr|cricket|t20|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s5-2/c/matrix-triple-rr-cricket-t20-lifecycle never showed within 15000 …
- [harness-error] `triple_rr|boardgame|blitz|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s6-2/c/matrix-triple-rr-boardgame-blitz-lifecycle never showed within 15…
- [harness-error] `triple_rr|carrom|club-29|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s7-2/c/matrix-triple-rr-carrom-club-29-lifecycle never showed within 150…
- [harness-error] `triple_rr|generic|score|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s8-2/c/matrix-triple-rr-generic-score-lifecycle never showed within 1500…
- [harness-error] `triple_rr|volleyball|beach|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s1-3/c/matrix-triple-rr-volleyball-beach-lifecycle never showed within 1…
- [harness-error] `triple_rr|badminton|bwf-3x15|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s2-3/c/matrix-triple-rr-badminton-bwf-3x15-lifecycle never showed within…
- [harness-error] `triple_rr|tabletennis|bo5|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s3-3/c/matrix-triple-rr-tabletennis-bo5-lifecycle never showed within 15…
- [harness-error] `triple_rr|tennis|tour|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s4-3/c/matrix-triple-rr-tennis-tour-lifecycle never showed within 15000 …
- [harness-error] `triple_rr|icehockey|iihf|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s5-3/c/matrix-triple-rr-icehockey-iihf-lifecycle never showed within 150…
- [harness-error] `triple_rr|hockey|fih-outdoor|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s6-3/c/matrix-triple-rr-hockey-fih-outdoor-lifecycle never showed within…
- [harness-error] `league_ko|football|11-a-side|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s7-3/c/matrix-league-ko-football-11-a-side-lifecycle never showed within…
- [harness-error] `league_ko|cricket|t20|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s8-3/c/matrix-league-ko-cricket-t20-lifecycle never showed within 15000 …
- [harness-error] `league_ko|boardgame|blitz|LIFECYCLE@1280` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l1-s1-4/c/matrix-league-ko-boardgame-blitz-lifecycle never showed within 15…
- … and 140 more

**L2** — 56 faults: harness-error 56

- [harness-error] `league|football|11-a-side|R4a@390` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-32/c/matrix-league-football-11-a-side-r4a never showed within 15000 m…
- [harness-error] `triple_rr|cricket|t20|R4a@430` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-33/c/matrix-triple-rr-cricket-t20-r4a never showed within 15000 ms (p…
- [harness-error] `league_ko|boardgame|blitz|R4a@768` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-33/c/matrix-league-ko-boardgame-blitz-r4a never showed within 15000 m…
- [harness-error] `groups_ko|carrom|club-29|R4a@834` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-34/c/matrix-groups-ko-carrom-club-29-r4a never showed within 15000 ms…
- [harness-error] `group_stepladder|generic|score|R4a@320` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-34/c/matrix-group-stepladder-generic-score-r4a never showed within 15…
- [harness-error] `group_playoffs|volleyball|beach|R4a@360` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-35/c/matrix-group-playoffs-volleyball-beach-r4a never showed within 1…
- [harness-error] `swiss|badminton|bwf-3x15|R4a@375` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-35/c/matrix-swiss-badminton-bwf-3x15-r4a never showed within 15000 ms…
- [harness-error] `swiss_playoff|tabletennis|bo5|R4a@390` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-36/c/matrix-swiss-playoff-tabletennis-bo5-r4a never showed within 150…
- [harness-error] `swiss_knockout|tennis|tour|R4a@430` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-36/c/matrix-swiss-knockout-tennis-tour-r4a never showed within 15000 …
- [harness-error] `knockout|icehockey|iihf|R4a@768` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-37/c/matrix-knockout-icehockey-iihf-r4a never showed within 15000 ms …
- [harness-error] `ko_plate|hockey|fih-outdoor|R4a@834` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-37/c/matrix-ko-plate-hockey-fih-outdoor-r4a never showed within 15000…
- [harness-error] `qualifying_main|football|11-a-side|R4a@320` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-38/c/matrix-qualifying-main-football-11-a-side-r4a never showed withi…
- [harness-error] `double_elim|football|11-a-side|R4a@360` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-38/c/matrix-double-elim-football-11-a-side-r4a never showed within 15…
- [harness-error] `ladder|football|11-a-side|R4a@430` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-40/c/matrix-ladder-football-11-a-side-r4a never showed within 15000 m…
- [harness-error] `group_only|football|11-a-side|R4a@768` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-40/c/matrix-group-only-football-11-a-side-r4a never showed within 150…
- [harness-error] `group_group_ko|football|11-a-side|R4a@834` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-41/c/matrix-group-group-ko-football-11-a-side-r4a never showed within…
- [harness-error] `knockout_third_place|football|11-a-side|R4a@320` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-41/c/matrix-knockout-third-place-football-11-a-side-r4a never showed …
- [harness-error] `page_playoff_only|football|11-a-side|R4a@360` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-42/c/matrix-page-playoff-only-football-11-a-side-r4a never showed wit…
- [harness-error] `stepladder_only|football|11-a-side|R4a@375` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-42/c/matrix-stepladder-only-football-11-a-side-r4a never showed withi…
- [harness-error] `league|football|11-a-side|M1@430` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-204/c/matrix-league-football-11-a-side-m1 never showed within 15000 m…
- [harness-error] `triple_rr|cricket|t20|M1@768` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-205/c/matrix-triple-rr-cricket-t20-m1 never showed within 15000 ms (p…
- [harness-error] `league_ko|boardgame|blitz|M1@834` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-205/c/matrix-league-ko-boardgame-blitz-m1 never showed within 15000 m…
- [harness-error] `groups_ko|carrom|club-29|M1@320` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-206/c/matrix-groups-ko-carrom-club-29-m1 never showed within 15000 ms…
- [harness-error] `group_stepladder|generic|score|M1@360` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s2-206/c/matrix-group-stepladder-generic-score-m1 never showed within 15…
- [harness-error] `group_playoffs|volleyball|beach|M1@375` — error: ScreenNeverShowed: browser: the new competition's page /o/m-ci-41818942253-1-l2-s1-207/c/matrix-group-playoffs-volleyball-beach-m1 never showed within 1…
- … and 31 more

## Timings (driven cases only)

| layer | driven | p50 | p90 | max |
|---|---|---|---|---|
| L1 | 166 | 15.9 s | 16.1 s | 123.6 s |
| L2 | 56 | 15.9 s | 16.1 s | 16.1 s |
| L3 | 930 | 3.2 s | 6.9 s | 11.1 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-41818942253-1-l1) — exit 1, 229 cases compared, 165 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-41818942253-1-l2) — exit 1, 1729 cases compared, 56 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-41818942253-1-l3) — exit 0, 930 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

348 cases changed state since run 41184503925 (2888 compared):

- L1: 229 cases in both runs
  - ✅→❌ (160): `league|football|11-a-side|LIFECYCLE@1280`, `league|cricket|t20|LIFECYCLE@1280`, `league|boardgame|blitz|LIFECYCLE@1280`, `league|carrom|club-29|LIFECYCLE@1280`, `league|generic|score|LIFECYCLE@1280`, `league|volleyball|beach|LIFECYCLE@1280`, `league|badminton|bwf-3x15|LIFECYCLE@1280`, `league|tabletennis|bo5|LIFECYCLE@1280`, `league|tennis|tour|LIFECYCLE@1280`, `league|icehockey|iihf|LIFECYCLE@1280`, `league|hockey|fih-outdoor|LIFECYCLE@1280`, `triple_rr|football|11-a-side|LIFECYCLE@1280`, `triple_rr|cricket|t20|LIFECYCLE@1280`, `triple_rr|boardgame|blitz|LIFECYCLE@1280`, `triple_rr|carrom|club-29|LIFECYCLE@1280`, `triple_rr|generic|score|LIFECYCLE@1280`, `triple_rr|volleyball|beach|LIFECYCLE@1280`, `triple_rr|badminton|bwf-3x15|LIFECYCLE@1280`, `triple_rr|tabletennis|bo5|LIFECYCLE@1280`, `triple_rr|tennis|tour|LIFECYCLE@1280`, `triple_rr|icehockey|iihf|LIFECYCLE@1280`, `triple_rr|hockey|fih-outdoor|LIFECYCLE@1280`, `league_ko|football|11-a-side|LIFECYCLE@1280`, `league_ko|cricket|t20|LIFECYCLE@1280`, `league_ko|boardgame|blitz|LIFECYCLE@1280`, … and 135 more
  - ✅→🚫 (5): `americano|football|11-a-side|LIFECYCLE@1280`, `americano|cricket|t20|LIFECYCLE@1280`, `americano|volleyball|beach|LIFECYCLE@1280`, `americano|icehockey|iihf|LIFECYCLE@1280`, `americano|hockey|fih-outdoor|LIFECYCLE@1280`
  - ❌→🚫 (5): `mexicano|football|11-a-side|LIFECYCLE@1280`, `mexicano|cricket|t20|LIFECYCLE@1280`, `mexicano|volleyball|beach|LIFECYCLE@1280`, `mexicano|icehockey|iihf|LIFECYCLE@1280`, `mexicano|hockey|fih-outdoor|LIFECYCLE@1280`
- L2: 1729 cases in both runs
  - ░→🚫 (128): `americano|football|11-a-side|R1@834`, `mexicano|football|11-a-side|R1@320`, `americano|football|11-a-side|R2@320`, `mexicano|football|11-a-side|R2@360`, `americano|football|11-a-side|R3@360`, `mexicano|football|11-a-side|R3@375`, `americano|football|11-a-side|R4c@320`, `mexicano|football|11-a-side|R4c@360`, `americano|football|11-a-side|R5@360`, `mexicano|football|11-a-side|R5@375`, `americano|football|11-a-side|R7@834`, `mexicano|football|11-a-side|R7@320`, `americano|football|11-a-side|R8@320`, `mexicano|football|11-a-side|R8@360`, `americano|football|11-a-side|R9a@360`, `mexicano|football|11-a-side|R9a@375`, `americano|football|11-a-side|R9b@375`, `mexicano|football|11-a-side|R9b@390`, `americano|football|11-a-side|R10@390`, `mexicano|football|11-a-side|R10@430`, `americano|football|11-a-side|R11a@430`, `mexicano|football|11-a-side|R11a@768`, `americano|football|11-a-side|R14@768`, `mexicano|football|11-a-side|R14@834`, `americano|football|11-a-side|R16@375`, … and 103 more
  - ✅→❌ (41): `league|football|11-a-side|R4a@390`, `triple_rr|cricket|t20|R4a@430`, `league_ko|boardgame|blitz|R4a@768`, `groups_ko|carrom|club-29|R4a@834`, `group_stepladder|generic|score|R4a@320`, `group_playoffs|volleyball|beach|R4a@360`, `swiss|badminton|bwf-3x15|R4a@375`, `swiss_playoff|tabletennis|bo5|R4a@390`, `swiss_knockout|tennis|tour|R4a@430`, `knockout|icehockey|iihf|R4a@768`, `ko_plate|hockey|fih-outdoor|R4a@834`, `qualifying_main|football|11-a-side|R4a@320`, `double_elim|football|11-a-side|R4a@360`, `ladder|football|11-a-side|R4a@430`, `league|football|11-a-side|M1@430`, `triple_rr|cricket|t20|M1@768`, `league_ko|boardgame|blitz|M1@834`, `groups_ko|carrom|club-29|M1@320`, `group_stepladder|generic|score|M1@360`, `group_playoffs|volleyball|beach|M1@375`, `swiss|badminton|bwf-3x15|M1@390`, `swiss_playoff|tabletennis|bo5|M1@430`, `swiss_knockout|tennis|tour|M1@768`, `knockout|icehockey|iihf|M1@834`, `ko_plate|hockey|fih-outdoor|M1@320`, … and 16 more
  - ❌→🚫 (4): `americano|football|11-a-side|R4a@375`, `mexicano|football|11-a-side|R4a@390`, `mexicano|football|11-a-side|M1@430`, `mexicano|football|11-a-side|F1@375`
  - ✅→🚫 (2): `americano|football|11-a-side|M1@390`, `americano|football|11-a-side|F1@360`
- L3: 930 cases in both runs
  - ❌→✅ (3): `swiss_playoff|hockey|fih-outdoor|R4`, `swiss_knockout|boardgame|blitz|R4`, `swiss_knockout|hockey|fih-outdoor|R4`
