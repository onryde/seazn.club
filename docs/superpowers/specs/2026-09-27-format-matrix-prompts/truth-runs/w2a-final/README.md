# W2a final truth run: the 77 cells after the fix, and the full regression

Task 16 of W2a (plan `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md`) judges the "after" half of the 77 SC-O reds (`../w2a-repro/expect-77.json`, re-keys `../w2a-repro/expect-77-rekeys.json`, ruling D-P2) and runs the whole matrix on CI against the W1d baseline (`../w1d-baseline`, workflow run 37346206686).

**Verdict: NEGATIVE.** The judge finds 0 wrong reasons and 0 greened pins, but 1 unexpected red locally and 2 on CI. The full regression is clean on L1 and L2, and L3 has 9 regressions, all from one harness cause (below). No product defect was found.

## The runs

| | |
|---|---|
| CI | workflow "Matrix truth run", run **37916609028**, `event` workflow_dispatch, `headSha` `e45d7420394b3676f5f973ba8533085c855404a4` (the branch tip when dispatched), conclusion success, 2026-10-09 10:16–10:35 UTC. Merged artifact `merged` → `ci/`: L1 8 shards, L2 2, L3 2; `SUMMARY.md` "Run complete: yes", harness faults none. `ci/L*/MATRIX.md` re-rendered locally with `pnpm matrix:render ci/<L>/results.json --out …` is byte-identical for all three layers. |
| local | branch `feat/format-matrix-w2a`, label `w2ae2` (`seazn-env up`; fresh Postgres, `show data_directory` = the label's own datadir, exported as `BENCH_EXPECTED_DATA_DIR`), production standalone build of this worktree with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`. 62 L3 pair runs at harness `e45d74203` (clean); 11 L1 stripes, 3 L2 stripes and the 5 new scenarios. 2 L1 stripes (7, 16) are at `e45d74203`, clean. The other 9 L1 stripes, the 3 L2 stripes and the 5 new-scenario runs were first recorded as `e45d74203-dirty` (an uncommitted `scripts/smoke.ts`; no harness or product file differed), so they were re-run as `w2a-final2-*` at `dbff3e5cc` (a clean tree; it differs from `e45d74203` in `scripts/smoke.ts` only). Only clean runs are committed. Every run printed `EXIT=0` (reds are data). |

## Judges

Per layer, `pnpm matrix:judge regression --baseline ../w1d-baseline/<L>/results.json --now ci/<L>/results.json --expect <the run's own case ids>` (`judge-<L>.json`):

| layer | exit | compared | newly red | absent |
|---|---|---|---|---|
| L1 | 0 | 231 | 0 | 0 |
| L2 | 0 | 517 | 0 | 0 |
| L3 | **1** | 937 | **9** | 0 |

    ci-37916609028-1-l3 against the baseline ci-37346206686-1-l3: compared 937 cases; 9 regressions
    baseline overrides: 3 case(s) held red (cause P6, SW-H1, W3) — owner ruling 70

The 9 are `page_playoff_only|<sport>|M1` for football, cricket, carrom, volleyball, badminton, table tennis, tennis, ice hockey and hockey, each `works → red`, each `life-bracket-decider-exercised: 1 bracket stage(s) and no decider posted (0 settles, 0 tie-breaks)`.

Ruling D-P2 (`tools/matrix/w2a-expect.ts`), CI first (`w2a-expect-ci.json`, exit **1**):

    expected 77, found 77: 69 works, 6 red as pinned, 0 greened; 2 unexpected red, 0 wrong reason (2897 case(s) read)
      unexpected red page_playoff_only|generic|score|M1: red - life-bracket-decider-exercised: 1 bracket stage(s) and no decider posted (0 settles, 0 tie-breaks)
      unexpected red swiss_playoff|generic|score|R4: red - I4-nothing-ends-stuck: stage 1: round 5 paired nobody (SW-H1); life-bracket-decider-exercised: 1 bracket stage(s) and no decider posted (0 settles, 0 tie-breaks); life-loop-bounded: play loop exited empty_pair_round

Local (`w2a-expect-local.json`, the 81 committed local runs, exit **1**):

    expected 77, found 77: 70 works, 6 red as pinned, 0 greened; 1 unexpected red, 0 wrong reason (319 case(s) read)
      unexpected red page_playoff_only|generic|score|M1: red - life-bracket-decider-exercised: 1 bracket stage(s) and no decider posted (0 settles, 0 tie-breaks)

**The six re-keyed cells are red as pinned, on CI and locally alike.** The five boardgame R4 cells (`knockout`, `knockout_third_place`, `ko_plate`, `double_elim`, `qualifying_main`) fail no check (`failing: []`) and carry the `WRONG_PHASE: forfeit not allowed in phase "pre"` refusal, which CD-T13 owns in W2b. `ko_plate|boardgame|blitz|F1` fails exactly `I4-nothing-ends-stuck`, `life-loop-bounded` and `advance-seeded-as-declared`, with stage 1's `/complete` answering 409 `STAGE_COMPLETED_SEEDING_FAILED`; FX-G14 owns it in W4.

**`greened` (a pin whose cell now works, i.e. a stale pin): none, on CI and locally.**

## The two unexpected reds

1. **`page_playoff_only|*|M1`: a harness defect, not the product.** This takes 10 sports on CI (9 W1d-green, plus generic) and generic locally. Boardgame is the one sport that stays green. Fix round 1 of phase 3 (`b7b1ff74d`, M-6) added `life-bracket-decider-exercised` to M1 (`tools/matrix/lib/scenarios/m1-walkover.ts:110-113`). The comment there says the walkover took the first bracket fixture, so the policy's next hard-path slot is the fourth. On a page playoff there is no fourth.
   - The walkover is posted from `beforeRound` on `pp-q1`. `decideRound` (`tools/matrix/lib/scenarios/common.ts`) still gives that fixture bracket ordinal 0, the run's only hard-path slot (`bracketPolicy`: `ordinal % 3 === 0`), and `decideFixture` returns early because the harness already finished it.
   - The walkover's loser is not seated in `pp-q2`, so the product records `pp-q2` as a bye award (`{"kind":"award"}`, home seat empty, no events) and it never reaches a batch.
   - Only `pp-elim` (ordinal 1) and `pp-final` (ordinal 2) are driven, both as plain wins. The run read back from the local database: q1 forfeited/walkover, elim decided, q2 forfeited award, final decided.
   - Every product check passes (I2 5/5, I4 7/7, the stage completes, m1-winner-progresses).
   - Boardgame passes because its forfeit rides the pad as a sport result, so `pp-q2` is played and `pp-final` lands on ordinal 3.
   - This fix belongs to tools/matrix test wiring that this task was not assigned, so it is routed to the controller, not fixed here.
2. **`swiss_playoff|generic|score|R4` (SC-O2): SW-H1, owned by P6/W3, not a W2a regression.** Locally the cell works (15 checks, 172 items): W2a's fix closed the stage-2 drawn-game stall. On CI, Swiss stage 1's round 5 paired nobody (SW-H1), so the knockout stage was never reached, which also fails the decider check. This is the flip the IDX records ("The swiss_playoff R4 reason flip"): SW-H1 is the `lots` tie-break's UUID-hashed draw, intermittent by design. The pin set does not hold it, and the pins are not this task's to edit (D-P2).

## swiss_playoff R4 on CI against W1d (Task 16 Step 4; 11 cells checked)

| cell | W1d | W2a CI | class |
|---|---|---|---|
| `swiss_playoff\|boardgame\|blitz\|R4` (SC-O1) | red: stage 2 did not complete (stall) | works | **predicted fix** (W2a) |
| `swiss_playoff\|generic\|score\|R4` (SC-O2) | red: stage 2 did not complete (stall) | red: round 5 paired nobody (SW-H1) | **reason flip to SW-H1** (P6, W3); works locally |
| `swiss_playoff\|hockey\|fih-outdoor\|R4` | red: SW-H1 | red: SW-H1 | unchanged (P6, W3) |
| the other 8 sports | works | works | unchanged |

## New scenarios (local, `dbff3e5cc`)

| scenario | cases | works | `life-bracket-decider-exercised` | `reference-bracket-finish` |
|---|---|---|---|---|
| BRACKET_SETTLE_LEVEL | 24 | 24 | pass 24 | pass 24 |
| BRACKET_SETTLE_ABANDON | 88 | 88 | pass 88 | pass 88 |
| BRACKET_TIEBREAK | 8 | 8 | pass 8 | pass 8 |
| BRACKET_EXTRA_BOARD | 8 | 8 | not carried (by design: its extra board is the pad's and it posts no settle; `assertions.ts` M-6 note) | pass 8 |
| BRACKET_NO_DRAW_GENERIC | 8 | 8 | pass 8 | pass 8 |

## Matrix movement, CI against W1d

| layer | W1d works / red | W2a works / red |
|---|---|---|
| L1 | 155 / 23 | 167 / 11 |
| L2 | 40 / 22 | 43 / 19 |
| L3 | 773 / 164 | 819 / 118 |

## Layout

| path | what |
|---|---|
| `ci/SUMMARY.md`, `ci/<L>/{results.json,MATRIX.md,judge.json}` | the merged CI artifact of run 37916609028 (its `faults.txt` files are not committed, because `committed-matrix` reads JSON and Markdown only; `judge.json` holds the same faults verdict, exit 0, 0 faults per layer) |
| `judge-<L>.json` | the regression judge against `../w1d-baseline/<L>` |
| `w2a-expect-ci.json`, `w2a-expect-local.json` | ruling D-P2's judge over the CI runs and over the local runs |
| `local/L3/w2a-final-<n>` | one run per (row, sport) pair of `../w2a-local-selection.json` (62) |
| `local/L3/w2a-final2-new-<scenario>` | the 5 new scenarios, `--set w1-driving --scenario <key>` |
| `local/L1/w2a-final{,2}-l1-s<k>`, `local/L2/w2a-final2-l2-s<k>` | the grid stripes `k/64` (`browserShards`) |

Lock entries (`../plans.lock.json`): 84 added (3 merged CI runs as printed, 67 L3 runs as printed, 14 stripe runs restricted to their stripe as the repro's were: each restricted entry holds exactly `stripeSize(planSize, shard)` items, every run case is a plan item, `judgeRun` is clean). `pnpm matrix:lock-check --against HEAD`: 174 compared, 84 added. `committed-matrix.test.ts`: 28/28. Run shots (`shots/`) are not committed.

This dispatch counts as a weekly matrix truth run (`MATRIX_WEEKLY_ENABLED=true` since 2026-10-08).
