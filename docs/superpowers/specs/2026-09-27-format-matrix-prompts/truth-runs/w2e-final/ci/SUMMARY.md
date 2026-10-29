# Matrix truth run summary

Previous complete run: 2026-10-29 (0 days ago) — run 40869943107

Harness faults in this run: none (3 of 3 layers present).

**Run complete: yes** — every layer merged, no merged case is a harness fault, and a `judge faults` verdict (exit 0) is bound to each layer's merged run.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-40874582041-1-l1 | 8 | 229 | 176 | 166 | 0 | 10 | 0 | 0 | 53 | 0 | 0 |
| L2 | L2 (grid) | ci-40874582041-1-l2 | 2 | 1729 | 62 | 43 | 0 | 19 | 0 | 0 | 145 | 1522 | 0 |
| L3 | — | ci-40874582041-1-l3 | 2 | 930 | 930 | 831 | 0 | 99 | 0 | 0 | 0 | 0 | 0 |

## Planned ░ by atom

- L1: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
**L2** — 1522 planned ░ across 82 atoms:

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
| M12b | 19 |
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
| L1 | 176 | 24.2 s | 59.0 s | 136.9 s |
| L2 | 62 | 16.9 s | 22.5 s | 125.2 s |
| L3 | 930 | 3.3 s | 7.0 s | 11.5 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-40874582041-1-l1) — exit 0, 229 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-40874582041-1-l2) — exit 0, 1729 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-40874582041-1-l3) — exit 0, 930 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

210 cases changed state since run 40869943107 (2888 compared):

- L1: 229 cases in both runs
  - ❌→✅ (164): `league|football|11-a-side|LIFECYCLE@1280`, `league|cricket|t20|LIFECYCLE@1280`, `league|boardgame|blitz|LIFECYCLE@1280`, `league|carrom|club-29|LIFECYCLE@1280`, `league|generic|score|LIFECYCLE@1280`, `league|volleyball|beach|LIFECYCLE@1280`, `league|badminton|bwf-3x15|LIFECYCLE@1280`, `league|tabletennis|bo5|LIFECYCLE@1280`, `league|tennis|tour|LIFECYCLE@1280`, `league|icehockey|iihf|LIFECYCLE@1280`, `league|hockey|fih-outdoor|LIFECYCLE@1280`, `triple_rr|football|11-a-side|LIFECYCLE@1280`, `triple_rr|cricket|t20|LIFECYCLE@1280`, `triple_rr|boardgame|blitz|LIFECYCLE@1280`, `triple_rr|carrom|club-29|LIFECYCLE@1280`, `triple_rr|generic|score|LIFECYCLE@1280`, `triple_rr|volleyball|beach|LIFECYCLE@1280`, `triple_rr|badminton|bwf-3x15|LIFECYCLE@1280`, `triple_rr|tabletennis|bo5|LIFECYCLE@1280`, `triple_rr|tennis|tour|LIFECYCLE@1280`, `triple_rr|icehockey|iihf|LIFECYCLE@1280`, `triple_rr|hockey|fih-outdoor|LIFECYCLE@1280`, `league_ko|football|11-a-side|LIFECYCLE@1280`, `league_ko|cricket|t20|LIFECYCLE@1280`, `league_ko|boardgame|blitz|LIFECYCLE@1280`, … and 139 more
- L2: 1729 cases in both runs
  - ❌→✅ (43): `league|football|11-a-side|R4a@390`, `triple_rr|cricket|t20|R4a@430`, `league_ko|boardgame|blitz|R4a@768`, `groups_ko|carrom|club-29|R4a@834`, `group_stepladder|generic|score|R4a@320`, `group_playoffs|volleyball|beach|R4a@360`, `swiss|badminton|bwf-3x15|R4a@375`, `swiss_playoff|tabletennis|bo5|R4a@390`, `swiss_knockout|tennis|tour|R4a@430`, `knockout|icehockey|iihf|R4a@768`, `ko_plate|hockey|fih-outdoor|R4a@834`, `qualifying_main|football|11-a-side|R4a@320`, `double_elim|football|11-a-side|R4a@360`, `ladder|football|11-a-side|R4a@430`, `league|football|11-a-side|M1@430`, `triple_rr|cricket|t20|M1@768`, `league_ko|boardgame|blitz|M1@834`, `groups_ko|carrom|club-29|M1@320`, `group_stepladder|generic|score|M1@360`, `group_playoffs|volleyball|beach|M1@375`, `swiss|badminton|bwf-3x15|M1@390`, `swiss_playoff|tabletennis|bo5|M1@430`, `swiss_knockout|tennis|tour|M1@768`, `knockout|icehockey|iihf|M1@834`, `ko_plate|hockey|fih-outdoor|M1@320`, … and 18 more
- L3: 930 cases in both runs
  - ✅→❌ (2): `swiss_playoff|football|11-a-side|R4`, `swiss_knockout|carrom|club-29|R4`
  - ❌→✅ (1): `swiss_playoff|generic|score|R4`
  - expected, not a regression: `swiss_knockout|carrom|club-29|R4` ✅→❌ — the lots draw is by design (owner ruling 70; P6, audit SW-H1, W3)
