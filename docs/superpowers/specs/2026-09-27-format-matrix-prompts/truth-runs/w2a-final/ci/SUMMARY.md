# Matrix truth run summary

Previous complete run: 2026-10-05 (3 days ago) — run 37346206686

Harness faults in this run: none (3 of 3 layers present).

**Run complete: yes** — every layer merged, no merged case is a harness fault, and a `judge faults` verdict (exit 0) is bound to each layer's merged run.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-37916609028-1-l1 | 8 | 231 | 178 | 167 | 0 | 11 | 0 | 0 | 53 | 0 | 0 |
| L2 | L2 (grid) | ci-37916609028-1-l2 | 2 | 1729 | 62 | 43 | 0 | 19 | 0 | 0 | 164 | 1503 | 0 |
| L3 | — | ci-37916609028-1-l3 | 2 | 937 | 937 | 819 | 0 | 118 | 0 | 0 | 0 | 0 | 0 |

## Planned ░ by atom

- L1: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
**L2** — 1503 planned ░ across 81 atoms:

| atom | planned |
|---|---|
| C1 | 21 |
| C2 | 21 |
| C3a | 21 |
| C3b | 21 |
| C6a | 21 |
| C6b | 21 |
| C7 | 21 |
| D3 | 21 |
| D5a | 21 |
| D5b | 21 |
| D6 | 21 |
| D7 | 21 |
| E1 | 21 |
| E3 | 21 |
| E4a | 21 |
| E4b | 21 |
| F2 | 21 |
| M10 | 21 |
| M11 | 21 |
| M12a | 21 |
| M12c | 21 |
| M2 | 21 |
| M3 | 21 |
| M4a | 21 |
| M4b | 21 |
| M6 | 21 |
| M7a | 21 |
| M7b | 21 |
| M8a | 21 |
| M8b | 21 |
| M9a | 21 |
| M9b | 21 |
| P1 | 21 |
| P3 | 21 |
| P4 | 21 |
| P5a | 21 |
| P6 | 21 |
| R1 | 21 |
| R10 | 21 |
| R11a | 21 |
| R11b | 21 |
| R12a | 21 |
| R12b | 21 |
| R16 | 21 |
| R2 | 21 |
| R3 | 21 |
| R4c | 21 |
| R5 | 21 |
| R7 | 21 |
| R8 | 21 |
| R9a | 21 |
| R9b | 21 |
| X1a | 21 |
| X1b | 21 |
| X3 | 21 |
| X4a | 21 |
| X4b | 21 |
| X4c | 21 |
| R14 | 17 |
| F8 | 16 |
| M5 | 15 |
| C4 | 14 |
| P7 | 14 |
| X2 | 14 |
| F5a | 13 |
| F5b | 13 |
| F6 | 13 |
| F7 | 13 |
| F3 | 11 |
| F4 | 11 |
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

None in the 3 layers present: no crash, harness error, vacuous red, setup refusal or unplanned ░ (D6; planned ░ allowed, ruling 65).

## Timings (driven cases only)

| layer | driven | p50 | p90 | max |
|---|---|---|---|---|
| L1 | 178 | 20.7 s | 52.8 s | 127.2 s |
| L2 | 62 | 15.1 s | 24.2 s | 119.1 s |
| L3 | 937 | 2.8 s | 6.5 s | 11.3 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-37916609028-1-l1) — exit 0, 231 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-37916609028-1-l2) — exit 0, 1729 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-37916609028-1-l3) — exit 0, 937 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

78 cases changed state since run 37346206686 (1685 compared):

- L1: 231 cases in both runs
  - ❌→✅ (12): `league_ko|boardgame|blitz|LIFECYCLE@1280`, `groups_ko|boardgame|blitz|LIFECYCLE@1280`, `group_stepladder|boardgame|blitz|LIFECYCLE@1280`, `group_playoffs|boardgame|blitz|LIFECYCLE@1280`, `group_playoffs|generic|score|LIFECYCLE@1280`, `swiss_playoff|boardgame|blitz|LIFECYCLE@1280`, `swiss_playoff|generic|score|LIFECYCLE@1280`, `swiss_knockout|boardgame|blitz|LIFECYCLE@1280`, `knockout|boardgame|blitz|LIFECYCLE@1280`, `ko_plate|boardgame|blitz|LIFECYCLE@1280`, `qualifying_main|boardgame|blitz|LIFECYCLE@1280`, `double_elim|boardgame|blitz|LIFECYCLE@1280`
- L2: 517 cases in both runs, 1212 added and 1214 removed since
  - ❌→✅ (2): `league_ko|boardgame|blitz|R4a@768`, `league_ko|boardgame|blitz|M1@834`
- L3: 937 cases in both runs
  - ❌→✅ (55): `league_ko|boardgame|blitz|LIFECYCLE`, `league_ko|boardgame|blitz|M1`, `league_ko|boardgame|blitz|R4`, `league_ko|boardgame|blitz|F1`, `groups_ko|boardgame|blitz|LIFECYCLE`, `groups_ko|boardgame|blitz|M1`, `groups_ko|boardgame|blitz|R4`, `groups_ko|boardgame|blitz|F1`, `group_stepladder|boardgame|blitz|LIFECYCLE`, `group_stepladder|boardgame|blitz|M1`, `group_stepladder|boardgame|blitz|R4`, `group_stepladder|boardgame|blitz|F1`, `group_playoffs|boardgame|blitz|LIFECYCLE`, `group_playoffs|boardgame|blitz|M1`, `group_playoffs|boardgame|blitz|R4`, `group_playoffs|boardgame|blitz|F1`, `group_playoffs|generic|score|LIFECYCLE`, `group_playoffs|generic|score|M1`, `group_playoffs|generic|score|R4`, `group_playoffs|generic|score|F1`, `swiss_playoff|boardgame|blitz|LIFECYCLE`, `swiss_playoff|boardgame|blitz|M1`, `swiss_playoff|boardgame|blitz|R4`, `swiss_playoff|boardgame|blitz|F1`, `swiss_playoff|generic|score|LIFECYCLE`, … and 30 more
  - ✅→❌ (9): `page_playoff_only|football|11-a-side|M1`, `page_playoff_only|cricket|t20|M1`, `page_playoff_only|carrom|club-29|M1`, `page_playoff_only|volleyball|beach|M1`, `page_playoff_only|badminton|bwf|M1`, `page_playoff_only|tabletennis|bo5|M1`, `page_playoff_only|tennis|tour|M1`, `page_playoff_only|icehockey|iihf|M1`, `page_playoff_only|hockey|fih-outdoor|M1`
  - expected, not a regression: `swiss_knockout|football|11-a-side|R4` ❌→✅ — the lots draw is by design (owner ruling 70; P6, audit SW-H1, W3)
