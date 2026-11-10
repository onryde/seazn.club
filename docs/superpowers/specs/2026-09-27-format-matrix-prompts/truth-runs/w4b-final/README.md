# W4 local selection run (PO ruling I1)

Selection: `../w4b-local-selection.json` (132 L3 cases, every cell of the 8 W4A/W4B keys). Base: app B `d26ef83f4c` (T15 + T16 + engine 6.0.3). Env: label `t15` (own Postgres, shared placement, fresh PROD build via `rebuild`), torn down after.
Command per key: `pnpm matrix:l3 --set w1-driving --scenario <KEY> --workers 4 --run-id <id> --report-dir <dir>`. Evidence here is the per-key `<KEY>.summary.json` (case id, state, reason, the scenario-owned `w4*` checks with their counts); the raw results.json files are not committed.

| key | works / cases | run | note |
|---|---|---|---|
| W4A_R2 | 22 / 22 | first | |
| W4A_R10 | 22 / 22 | first | |
| W4A_R6 | 11 / 11 | first | |
| W4B_Q3 | 22 / 22 | first | |
| W4B_Q3_OUT | 11 / 11 | re-run 3 (`-r3`) | first two runs red on SCRIPT defects, below |
| W4B_Q4A | 22 / 22 | re-run (`-r2`) | first run: 11 red on a script defect |
| W4B_Q5A | 10 / 11 | re-run (`-r2`) | 1 red = product, below |
| W4B_Q5B | 11 / 11 | first | |

Every scenario-owned check judged >= 13 items (min per key: R2 16, R10 23, R6 13, Q3 30, Q3_OUT 25, Q4A 22, Q5A 1 on the red cell / see summary, Q5B 14); none vacuous.

## Script defects found and fixed (tools/matrix)
1. life-results-as-posted red on results the PRODUCT wrote after the script's own organiser act (Q3_OUT: two withdrawals, the single `withdrawal` observation names one; Q4a: the declared joint final; Q5a). Fix: `Recorder.productActs` filled by `watchProductWrites` (every fixture the act newly finished); the check accepts it. Test: w4b-scenarios.test.ts.
2. Q3_OUT: the play loop re-calls generate, which the product refuses once two withdrawals leave 2 active entrants (below). Fix: the script decides the open final with playOut and completes directly.

## Product observations (not fixed)
1. `KO_THIRD_PLACE_TOO_FEW` (422) on a RE-generate of an already drawn Play-off bracket when withdrawals leave fewer than 4 ACTIVE entrants ("A third-place match needs at least 4 entrants. Use Shared third place instead."). RB4-T6 says a play-off whose two sides are out ends 4,4; the stage still completes (Q3_OUT 11/11 by deciding the open final) but generate is refused. Repro: knockout_third_place, 4 entrants, Start, withdraw seeds 3 and 4, POST /stages/:id/generate. Low impact (the desk does not re-generate).
2. `W4B_Q5A` `ko_plate|cricket|t20`: the plate's seed proposal (recomputeSeedProposal) is refused 422 `SEEDING_RULES_MISSING`, so the plate is never drawn and no plate entrant can withdraw. The other 10 sports draw it. Repro: ko_plate row on cricket t20, play round 1 of the main bracket, POST the plate's seed proposal. RB4-P1..P4 owe the plate on every sport.
