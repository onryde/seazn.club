# Matrix truth run summary

Previous complete run: 2026-11-11 (7 days ago) — run 42992170592

Harness faults in this run: none (3 of 3 layers present).

**Run complete: yes** — every layer merged, no merged case is a harness fault, and a `judge faults` verdict (exit 0) is bound to each layer's merged run.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-44420793924-1-l1 | 8 | 196 | 186 | 178 | 0 | 8 | 0 | 0 | 10 | 0 | 0 |
| L2 | L2 (grid) | ci-44420793924-1-l2 | 2 | 1513 | 47 | 47 | 27 | 0 | 16 | 0 | 207 | 1216 | 0 |
| L3 | — | ci-44420793924-1-l3 | 2 | 806 | 806 | 744 | 11 | 51 | 0 | 0 | 0 | 0 | 0 |

## Planned ░ by atom

- L1: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
**L2** — 1216 planned ░ across 83 atoms:

| atom | planned |
|---|---|
| R11b | 18 |
| R12a | 18 |
| R12b | 18 |
| C1 | 16 |
| C2 | 16 |
| C3a | 16 |
| C3b | 16 |
| C6a | 16 |
| C6b | 16 |
| C7 | 16 |
| D3 | 16 |
| D5a | 16 |
| D5b | 16 |
| D6 | 16 |
| D7 | 16 |
| E1 | 16 |
| E3 | 16 |
| E4a | 16 |
| E4b | 16 |
| F2 | 16 |
| M10 | 16 |
| M11 | 16 |
| M12a | 16 |
| M12c | 16 |
| M2 | 16 |
| M3 | 16 |
| M4a | 16 |
| M4b | 16 |
| M6 | 16 |
| M7a | 16 |
| M7b | 16 |
| M8a | 16 |
| M8b | 16 |
| M9a | 16 |
| M9b | 16 |
| P1 | 16 |
| P3 | 16 |
| P4 | 16 |
| P5a | 16 |
| P6 | 16 |
| R1 | 16 |
| R10 | 16 |
| R11a | 16 |
| R16 | 16 |
| R2 | 16 |
| R3 | 16 |
| R4c | 16 |
| R5 | 16 |
| R7 | 16 |
| R8 | 16 |
| R9a | 16 |
| R9b | 16 |
| X1a | 16 |
| X1b | 16 |
| X3 | 16 |
| X4a | 16 |
| X4b | 16 |
| X4c | 16 |
| F8 | 14 |
| M12b | 14 |
| M5 | 13 |
| R14 | 13 |
| Q4a | 12 |
| C4 | 11 |
| F3 | 11 |
| F4 | 11 |
| P2 | 11 |
| P5b | 11 |
| P7 | 11 |
| Q1a | 11 |
| Q1b | 11 |
| Q2 | 11 |
| Q3 | 11 |
| Q5a | 11 |
| Q5b | 11 |
| R15 | 11 |
| R4b | 11 |
| R6 | 11 |
| X2 | 11 |
| F5a | 10 |
| F5b | 10 |
| F6 | 10 |
| F7 | 10 |

- L3: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
## Harness faults

None in the 3 layers present: no crash, harness error, vacuous red, setup refusal or unplanned ░ (D6; planned ░ allowed, ruling 65).

## Timings (driven cases only)

| layer | driven | p50 | p90 | max |
|---|---|---|---|---|
| L1 | 186 | 22.2 s | 46.6 s | 127.9 s |
| L2 | 47 | 17.9 s | 25.7 s | 118.0 s |
| L3 | 806 | 2.8 s | 6.1 s | 10.2 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-44420793924-1-l1) — exit 0, 196 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-44420793924-1-l2) — exit 0, 1513 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-44420793924-1-l3) — exit 0, 806 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

43 cases changed state since run 42992170592 (1269 compared):

- L1: 195 cases in both runs, 1 added and 12 removed since
  - 🚫→✅ (20): `group_only|football|11-a-side|LIFECYCLE@1280`, `group_only|cricket|t20|LIFECYCLE@1280`, `group_only|boardgame|blitz|LIFECYCLE@1280`, `group_only|carrom|club-29|LIFECYCLE@1280`, `group_only|generic|score|LIFECYCLE@1280`, `group_only|volleyball|beach|LIFECYCLE@1280`, `group_only|tabletennis|bo5|LIFECYCLE@1280`, `group_only|tennis|tour|LIFECYCLE@1280`, `group_only|icehockey|iihf|LIFECYCLE@1280`, `group_only|hockey|fih-outdoor|LIFECYCLE@1280`, `group_group_ko|football|11-a-side|LIFECYCLE@1280`, `group_group_ko|boardgame|blitz|LIFECYCLE@1280`, `group_group_ko|carrom|club-29|LIFECYCLE@1280`, `group_group_ko|generic|score|LIFECYCLE@1280`, `group_group_ko|volleyball|beach|LIFECYCLE@1280`, `group_group_ko|badminton|bwf-3x15|LIFECYCLE@1280`, `group_group_ko|tabletennis|bo5|LIFECYCLE@1280`, `group_group_ko|tennis|tour|LIFECYCLE@1280`, `group_group_ko|icehockey|iihf|LIFECYCLE@1280`, `group_group_ko|hockey|fih-outdoor|LIFECYCLE@1280`
  - ❌→✅ (11): `ko_plate|football|11-a-side|LIFECYCLE@1280`, `ko_plate|cricket|t20|LIFECYCLE@1280`, `ko_plate|boardgame|blitz|LIFECYCLE@1280`, `ko_plate|carrom|club-29|LIFECYCLE@1280`, `ko_plate|generic|score|LIFECYCLE@1280`, `ko_plate|volleyball|beach|LIFECYCLE@1280`, `ko_plate|badminton|bwf-3x15|LIFECYCLE@1280`, `ko_plate|tabletennis|bo5|LIFECYCLE@1280`, `ko_plate|tennis|tour|LIFECYCLE@1280`, `ko_plate|icehockey|iihf|LIFECYCLE@1280`, `ko_plate|hockey|fih-outdoor|LIFECYCLE@1280`
- L2: 275 cases in both runs, 1238 added and 1314 removed since
  - ❌→✅ (1): `group_group_ko|football|11-a-side|R4a@834`
- L3: 799 cases in both runs, 7 added and 52 removed since
  - ❌→⛔ (11): `group_group_ko|football|11-a-side|F1`, `group_group_ko|cricket|t20|F1`, `group_group_ko|boardgame|blitz|F1`, `group_group_ko|carrom|club-29|F1`, `group_group_ko|generic|score|F1`, `group_group_ko|volleyball|beach|F1`, `group_group_ko|badminton|bwf-3x15|F1`, `group_group_ko|tabletennis|bo5|F1`, `group_group_ko|tennis|tour|F1`, `group_group_ko|icehockey|iihf|F1`, `group_group_ko|hockey|fih-outdoor|F1`
