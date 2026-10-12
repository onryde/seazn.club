# W2b final truth run: the local half (Task 16 Steps 1–3)

Task 16 of W2b (plan `docs/superpowers/plans/2026-10-09-format-matrix-w2b.md`; spec
`docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §8.3–5) drives the W2b cells locally: the five
boardgame R4 cells W2a re-keyed to CD-T13, and the five W2b scenarios. The CI half (the full matrix and the regression
judge, Steps 4–7) has not run yet, so there is no `ci/` and no top-level `MATRIX.md` here.

**Verdict: the R4 half passes; the new-scenario half is NEGATIVE.** All 5 R4 cells are `works`. Every W2b-owned
check passes, with `checked > 0` wherever it applies. But 23 of the 246 scenario cases are red, for three causes
(below), and none of them is a forfeit-after-Start case (rulings 112–114).

## The run

| | |
|---|---|
| branch | `feat/format-matrix-w2b` at `7c95a49f1` (results `harnessCommit` `7c95a49f1`, tree clean during the run) |
| database | a fresh Postgres from `seazn-env up --label w2b --placement` (Flyway to v435, then `sync:sports`); `show data_directory` printed `/tmp/seazn-env/w2b/pg`, the label's own datadir, exported as `BENCH_EXPECTED_DATA_DIR` |
| server | `seazn-env rebuild --label w2b`: a fresh production standalone build of this worktree (turbo cache miss), `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` baked and exported, PostHog and Sentry blank |
| placement | the label's own native service |
| selection | `../w2b-local-selection.json`: `cases` 5, `newScenarios` 5 (WO-PRE, RT-PART, DW-ALL, AB-AWARD, WD-CASC); both `browserShards` arrays empty, so the run is L3 only |
| command | the plan's Global Constraints truth-run command (W2a plan, w2a → w2b), `<tag>` = `final`; every line printed `EXIT=0` |
| time | 2026-10-12 06:25:36 – 06:28:52 UTC |

## Result

| run | cases | works | red | W2b checks (pass / abstain / fail) |
|---|---|---|---|---|
| `local/L3/w2b-final-1` … `-5` (R4) | 5 | **5** | 0 | — (11–12 checks each, 0 fail) |
| `local/L3/w2b-final-new-wo-pre` | 99 | 99 | 0 | 198 / 99 / 0 |
| `local/L3/w2b-final-new-rt-part` | 22 | 22 | 0 | 66 / 22 / 0 |
| `local/L3/w2b-final-new-dw-all` | 110 | 99 | **11** | 319 / 231 / 0 |
| `local/L3/w2b-final-new-ab-award` | 4 | 3 | **1** | 6 / 3 / 0 (the red cell ran no check) |
| `local/L3/w2b-final-new-wd-casc` | 11 | 0 | **11** | 49 / 0 / 0 |

"W2b checks" are the scenario-owned `w2b-*` checks plus `life-reference-bracket-finish`. No pass has `checked = 0`, and
every runner summary reads `vacuous: none`.

## The 23 red scenario cases, by cause

1. **`I2-bracket-one-champion-ranks-permutation` does not know a double walkover (22 cells: DW-ALL ×11, WD-CASC ×11,
   every `knockout|<sport>` cell).** `tools/matrix/lib/invariants.ts:164-168` (last changed by `b9497f9bf`, before
   W2b) has two problems with a double walkover:
   - It fails any terminal bracket fixture whose outcome has no winner (`<id>: bracket fixture ended double_walkover`).
   - It never adds the two DW sides to `lost`, so they count as unbeaten (`3 unbeaten entrants`, or 5 in WD-CASC).

   In the same cells the W2b checks that judge the double walkover itself all pass: recorded, advances nobody,
   final refused, table, and `life-reference-bracket-finish`. The repro2 run (`../w2b-repro/new`) could not show
   this, because the unfixed product refused every double walkover.
   **Class:** a harness gap. The generic invariant predates `double_walkover` (X-DW-1). It is not a product defect.
2. **WD-CASC's vacant-final half: Generate answers 500 (5 cells: cricket, carrom, volleyball, table tennis, ice
   hockey; the odd-indexed cells, `wdCascFinalHalf`).**
   - After the final is voided beside a voided feeder (title vacant, W4), the round loop calls Generate.
   - The server throws `generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label on fixture(s) … —
     this path is not supposed to be reachable with a label present` (5 `level:50` lines in the label's
     `server.log`).
   - Failing checks: `I4-nothing-ends-stuck`, `I8-generate-named`, `life-loop-bounded` (`refused_generate`).
   - `w2b-withdrawal-final-vacant` passes in all 5 (checked 2 each).

   **Class:** the known product assertion MB-004/MB-005 (`_INDEX.md`, routed W4 + W9), now reached by a new path: a
   void final.
3. **AB-AWARD `league|icehockey|iihf`: the level abandon is refused (1 cell).**
   - The leading abandon was accepted.
   - The level abandon, `core.abandon` at 1–1 on fixture `2db7dcf1…`, still `in_play` with START, 2 goals and no
     abandon stored, was refused `422 DRAW_NOT_ALLOWED: this stage cannot end level — decide it by extra time or a
     shootout`.
   - The case errored before any check ran.

   Why:
   - IH-AB-1 ("Same as FB-AB-1": a level award-policy abandon is a draw with the real score in draw kinds) folds
     the abandon to `{kind:"draw"}`.
   - `apps/web/src/server/engine-db/append-event.ts:516` refuses a draw wherever `supportsDraws` is false.
   - The `iihf` cfg (schema defaults) configures overtime and a shootout, so `supportsDraws(league)` is false
     (`packages/engine/src/sports/period/kernel.ts:2730`).
   - Football and FIH-outdoor hockey (no decider configured) work.
   - `award-abandon-status.test.ts` folds through `foldFrom` and `fixtureStatusFromFold` only, so no unit test
     reaches the append gate.

   **Class:** a conflict between rule IH-AB-1 and the no-draw gate, for an owner ruling. The organiser cannot record
   a level abandon of an IIHF league match at all.

## Step 2: the five rekeys (`w2a-expect-before.json`)

`tools/matrix/w2a-expect.ts`:
- `--expect ../w2a-repro/expect-77.json --rekeys ../w2a-repro/expect-77-rekeys.json`;
- `--now` the five local R4 runs (`local/L3/w2b-final-1` … `-5`; the plan's `local/L3/results.json` does not exist,
  because each run writes its own directory);
- then W2a's committed CI L3, L2 and L1.

Exit **1**:

    expected 77, found 77: 69 works, 2 red as pinned, 5 greened; 1 unexpected red, 0 wrong reason (2902 case(s) read)

- `greened` lists exactly the five boardgame R4 ids.
- The two non-W2b pins hold (`ko_plate|boardgame|blitz|F1` → W4, `swiss_playoff|generic|score|R4` → W3).
- The one unexpected red is `page_playoff_only|generic|score|M1`, read from W2a's own CI L3. That is W2a false
  premise 50, a harness defect W2a routed to the controller, unfixed on this branch. So the plan's "EXIT=0" cannot
  hold from these inputs.

Controller ruling R16-4 accepted that exit: its only cause is the M1 cell, W2a false premise 50. The five W2b
entries are now removed from `../w2a-repro/expect-77-rekeys.json`, and its `note` says they were removed by W2b Task 16
and judged greened here. The same judge, re-run on the same eight inputs (`w2a-expect-after.json`), gives exit 1:

    expected 77, found 77: 74 works, 2 red as pinned, 0 greened; 1 unexpected red, 0 wrong reason (2902 case(s) read)

- before: `greened` = exactly the five boardgame R4 ids; after: `greened` = `[]`.
- The one known failing cell, before and after, is `page_playoff_only|generic|score|M1`.

## Step 3: the probes, ungated

The `W2B_REPRO` gate is removed from `packages/engine/src/core/w2b-repro.probe.test.ts` and
`apps/web/src/server/__tests__/w2b-repro.probe.test.ts`; the web file keeps its database condition.

| file | env | total | passed | failed | pending |
|---|---|---|---|---|---|
| engine probes | none | 10 | 10 | 0 | 0 |
| web probes | the label's `DATABASE_URL`, no `W2B_REPRO` | 12 | 12 | 0 | 0 |
| web probes | `DATABASE_URL=` (empty) | 12 | 0 | 0 | 12 |
