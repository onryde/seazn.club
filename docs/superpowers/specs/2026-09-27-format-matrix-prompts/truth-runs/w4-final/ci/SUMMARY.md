# Matrix truth run summary

Previous complete run: 2026-11-10 (0 days ago) — run 42907051788

Harness faults in this run: none (3 of 3 layers present).

**Run complete: yes** — every layer merged, no merged case is a harness fault, and a `judge faults` verdict (exit 0) is bound to each layer's merged run.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-42992170592-1-l1 | 8 | 207 | 166 | 147 | 0 | 19 | 0 | 0 | 41 | 0 | 0 |
| L2 | L2 (grid) | ci-42992170592-1-l2 | 2 | 1589 | 48 | 42 | 27 | 6 | 16 | 0 | 282 | 1216 | 0 |
| L3 | — | ci-42992170592-1-l3 | 2 | 851 | 851 | 789 | 0 | 62 | 0 | 0 | 0 | 0 | 0 |

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
| M12b | 15 |
| F8 | 14 |
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
| R6 | 11 |
| X2 | 11 |
| F5a | 10 |
| F5b | 10 |
| F6 | 10 |
| F7 | 10 |
| R4b | 10 |

- L3: no planned ░ (every planned case is a 🚫, or the plan drives all it holds)
## Harness faults

None in the 3 layers present: no crash, harness error, vacuous red, setup refusal or unplanned ░ (D6; planned ░ allowed, ruling 65).

## Timings (driven cases only)

| layer | driven | p50 | p90 | max |
|---|---|---|---|---|
| L1 | 166 | 23.0 s | 99.6 s | 146.8 s |
| L2 | 48 | 19.1 s | 26.6 s | 30.5 s |
| L3 | 851 | 2.5 s | 5.4 s | 9.0 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-42992170592-1-l1) — exit 0, 207 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-42992170592-1-l2) — exit 0, 1589 cases compared, 0 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-42992170592-1-l3) — exit 0, 851 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

48 cases changed state since run 42907051788 (2647 compared):

- L1: 207 cases in both runs, no state changed
- L2: 1589 cases in both runs
  - ❌→✅ (3): `ko_plate|hockey|fih-outdoor|R4a@834`, `ko_plate|hockey|fih-outdoor|M1@320`, `ko_plate|hockey|fih-outdoor|F1@768`
- L3: 851 cases in both runs
  - ❌→✅ (45): `ko_plate|football|11-a-side|LIFECYCLE`, `ko_plate|football|11-a-side|M1`, `ko_plate|football|11-a-side|R4`, `ko_plate|football|11-a-side|F1`, `ko_plate|cricket|t20|LIFECYCLE`, `ko_plate|cricket|t20|M1`, `ko_plate|cricket|t20|R4`, `ko_plate|cricket|t20|F1`, `ko_plate|boardgame|blitz|LIFECYCLE`, `ko_plate|boardgame|blitz|M1`, `ko_plate|boardgame|blitz|R4`, `ko_plate|boardgame|blitz|F1`, `ko_plate|carrom|club-29|LIFECYCLE`, `ko_plate|carrom|club-29|M1`, `ko_plate|carrom|club-29|R4`, `ko_plate|carrom|club-29|F1`, `ko_plate|generic|score|LIFECYCLE`, `ko_plate|generic|score|M1`, `ko_plate|generic|score|R4`, `ko_plate|generic|score|F1`, `ko_plate|volleyball|beach|LIFECYCLE`, `ko_plate|volleyball|beach|M1`, `ko_plate|volleyball|beach|R4`, `ko_plate|volleyball|beach|F1`, `ko_plate|badminton|bwf-3x15|LIFECYCLE`, … and 20 more
