# Matrix truth run summary

Previous complete run: 2026-11-11 (7 days ago) — run 42992170592

Harness faults in this run: 12 (L1 6, L2 6).

**Run complete: no** — L1: 6 harness faults in this run; L1: this run's merged results hold 6 harness faults; L2: 6 harness faults in this run; L2: this run's merged results hold 6 harness faults.

Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)

## Layers

| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | L1 (grid) | ci-44395599687-1-l1 | 8 | 196 | 186 | 161 | 0 | 25 | 0 | 0 | 10 | 0 | 0 |
| L2 | L2 (grid) | ci-44395599687-1-l2 | 2 | 1513 | 48 | 42 | 27 | 6 | 16 | 0 | 206 | 1216 | 0 |
| L3 | — | ci-44395599687-1-l3 | 2 | 806 | 806 | 744 | 0 | 62 | 0 | 0 | 0 | 0 | 0 |

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

**L1** — 6 faults: harness-error 6

- [harness-error] `swiss|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-5825553f-d4e9-41da-8621-245fec726924"]').g…
- [harness-error] `swiss_playoff|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-a505c9db-151d-4c56-9cd6-7b51564dbc0b"]').g…
- [harness-error] `swiss_knockout|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-00eabe43-353a-4410-89f9-f5e703591391"]').g…
- [harness-error] `americano|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-9958c1ca-8020-4970-b937-81e535d91d38"]').g…
- [harness-error] `mexicano|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-9428f638-d4ab-4f5e-a785-c42bbf714f34"]').g…
- [harness-error] `ladder|tennis|tour|LIFECYCLE@1280` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-49258fe8-caad-4893-a929-717023bb031a"]').g…

**L2** — 6 faults: harness-error 6

- [harness-error] `swiss_knockout|tennis|tour|R4a@768` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-ff1ab14b-16ab-4b26-8312-d131b62131d5"]').g…
- [harness-error] `group_group_ko|football|11-a-side|R4a@834` — error: DriverMisuse: browser: group_group_ko|football is built through catalog template super-groups — plan the case with that template (CaseSpec.template, --s…
- [harness-error] `swiss_knockout|tennis|tour|M1@768` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-5c3e2b28-3452-4410-b53b-759cf3275ccd"]').g…
- [harness-error] `group_group_ko|football|11-a-side|M1@834` — error: DriverMisuse: browser: group_group_ko|football is built through catalog template super-groups — plan the case with that template (CaseSpec.template, --s…
- [harness-error] `swiss_knockout|tennis|tour|F1@390` — error: TimeoutError: locator.click: Timeout 17350ms exceeded. Call log: - waiting for locator('[id="stage-rail-sheet-08573d67-34cd-4cfd-8044-d64e7aa27bbb"]').g…
- [harness-error] `group_group_ko|football|11-a-side|F1@430` — error: DriverMisuse: browser: group_group_ko|football is built through catalog template super-groups — plan the case with that template (CaseSpec.template, --s…

## Timings (driven cases only)

| layer | driven | p50 | p90 | max |
|---|---|---|---|---|
| L1 | 186 | 23.9 s | 46.4 s | 129.3 s |
| L2 | 48 | 21.0 s | 40.9 s | 121.8 s |
| L3 | 806 | 2.9 s | 6.2 s | 10.6 s |

## Judge verdicts

- `merged/L1/judge.json`: L1 faults over 1 run (ci-44395599687-1-l1) — exit 1, 196 cases compared, 6 faults, 0 differing, 0 regressed
- `merged/L2/judge.json`: L2 faults over 1 run (ci-44395599687-1-l2) — exit 1, 1513 cases compared, 6 faults, 0 differing, 0 regressed
- `merged/L3/judge.json`: L3 faults over 1 run (ci-44395599687-1-l3) — exit 0, 806 cases compared, 0 faults, 0 differing, 0 regressed

## Weekly diff (informational)

46 cases changed state since run 42992170592 (1269 compared):

- L1: 195 cases in both runs, 1 added and 12 removed since
  - 🚫→✅ (18): `group_only|football|11-a-side|LIFECYCLE@1280`, `group_only|cricket|t20|LIFECYCLE@1280`, `group_only|boardgame|blitz|LIFECYCLE@1280`, `group_only|carrom|club-29|LIFECYCLE@1280`, `group_only|generic|score|LIFECYCLE@1280`, `group_only|volleyball|beach|LIFECYCLE@1280`, `group_only|tabletennis|bo5|LIFECYCLE@1280`, `group_only|icehockey|iihf|LIFECYCLE@1280`, `group_only|hockey|fih-outdoor|LIFECYCLE@1280`, `group_group_ko|football|11-a-side|LIFECYCLE@1280`, `group_group_ko|boardgame|blitz|LIFECYCLE@1280`, `group_group_ko|carrom|club-29|LIFECYCLE@1280`, `group_group_ko|generic|score|LIFECYCLE@1280`, `group_group_ko|volleyball|beach|LIFECYCLE@1280`, `group_group_ko|badminton|bwf-3x15|LIFECYCLE@1280`, `group_group_ko|tabletennis|bo5|LIFECYCLE@1280`, `group_group_ko|icehockey|iihf|LIFECYCLE@1280`, `group_group_ko|hockey|fih-outdoor|LIFECYCLE@1280`
  - ✅→❌ (14): `league|tennis|tour|LIFECYCLE@1280`, `league_ko|tennis|tour|LIFECYCLE@1280`, `groups_ko|tennis|tour|LIFECYCLE@1280`, `group_stepladder|tennis|tour|LIFECYCLE@1280`, `group_playoffs|tennis|tour|LIFECYCLE@1280`, `swiss|tennis|tour|LIFECYCLE@1280`, `swiss_playoff|tennis|tour|LIFECYCLE@1280`, `swiss_knockout|tennis|tour|LIFECYCLE@1280`, `knockout|tennis|tour|LIFECYCLE@1280`, `qualifying_main|tennis|tour|LIFECYCLE@1280`, `double_elim|tennis|tour|LIFECYCLE@1280`, `americano|tennis|tour|LIFECYCLE@1280`, `ladder|tennis|tour|LIFECYCLE@1280`, `knockout_third_place|tennis|tour|LIFECYCLE@1280`
  - ❌→✅ (10): `ko_plate|football|11-a-side|LIFECYCLE@1280`, `ko_plate|cricket|t20|LIFECYCLE@1280`, `ko_plate|boardgame|blitz|LIFECYCLE@1280`, `ko_plate|carrom|club-29|LIFECYCLE@1280`, `ko_plate|generic|score|LIFECYCLE@1280`, `ko_plate|volleyball|beach|LIFECYCLE@1280`, `ko_plate|badminton|bwf-3x15|LIFECYCLE@1280`, `ko_plate|tabletennis|bo5|LIFECYCLE@1280`, `ko_plate|icehockey|iihf|LIFECYCLE@1280`, `ko_plate|hockey|fih-outdoor|LIFECYCLE@1280`
  - 🚫→❌ (2): `group_only|tennis|tour|LIFECYCLE@1280`, `group_group_ko|tennis|tour|LIFECYCLE@1280`
- L2: 275 cases in both runs, 1238 added and 1314 removed since
  - ✅→❌ (2): `swiss_knockout|tennis|tour|M1@768`, `swiss_knockout|tennis|tour|F1@390`
- L3: 799 cases in both runs, 7 added and 52 removed since, no state changed
