# W5 truth run (W5 round-robin app PR A, Task 25)

CI run **44420793924** (`matrix-truth.yml`, `scope=full`, `workflow_dispatch` on `feat/w5-round-robin-app-a`), harness commit `e12f43eaaa`, artifact
`merged`. Evidence in `ci/`. **The run is complete** (`Run complete: yes`; `judge faults` exit 0 on all three layers, 0 harness faults) and is the committed
L3 baseline (`catalogue/baseline.json`). It is the third run of the PR: the first (44395599687) held 12 harness faults, the second (44411389618)
1 fault and the 11 `group_group_ko` F1 cells still red; both fixes landed in the harness and this run proves them.

| layer | cases | driven | works | refused | red | later | no path | planned |
|---|---|---|---|---|---|---|---|---|
| L1 | 196 | 186 | 178 | 0 | 8 | 0 | 10 | 0 |
| L2 | 1513 | 47 | 47 | 27 | 0 | 16 | 207 | 1216 |
| L3 | 806 | 806 | 744 | 11 | 51 | 0 | 0 | 0 |

## Judges (baseline = `../w4-final/ci/<L>/results.json`, `--expected-skips` = the baseline rows this run no longer holds)

| layer | EXIT | compared | skipped (all expected) | regressions |
|---|---|---|---|---|
| L1 | 0 | 195 | 12 | **0** |
| L2 | 0 | 275 | 1314 | **0** |
| L3 | 0 | 799 | 52 | **0** |

L2's compared count is small on purpose of the record: removing `triple_rr` (77 runs) moved the plain width rotation under 1139 committed runs, so most
L2 ids (which end `@<width>`) no longer match the baseline's. Read width-blind (same row, sport, preset, scenario) the L2 moves are listed below.

## Every move, by layer, and its cause

Read against the W4 baseline (`../w4-final`). Counts of cases whose id the two runs share, width-blind for L2.

**L1** (W4: 147 works, 19 red, 41 no path; now 178 works, 8 red, 10 no path)

| move | n | class | cause |
|---|---|---|---|
| `group_only` / `group_group_ko` no_path -> works | 20 | (b) expected | T14 (group_only has a picker card) and T15 (super-groups reaches group_group_ko on every sport): the cells are driven now |
| `ko_plate` red -> works | 11 | (d) main, not W5 | the W4 L1 reds were `ui-champion-shown` (the banner wanted a champion a plate stage never has); `bbd7ca9cd4` (11-11, after that run) made the champion skip losers-fed stages |
| `triple_rr` removed (11, no_path) | 11 | (b) expected | ruling 287 (T16) |
| `group_only\|badminton` `short` -> `bwf-3x15` | 1 + 1 | (b) expected | the card's own variant is the case's id now (X-BD-3) |
| 8 reds left: `swiss`, `swiss_playoff`, `swiss_knockout` x boardgame (builder posted `stage[1].config.chess`), `mexicano` x carrom, generic, badminton, tabletennis, tennis (stalled rounds) | 8 | unchanged | red in the W4 baseline too, in kind |

Tennis (14 L1 reds in the first run) is **works** again: `94af4e6b27` (11-12, TN-TS-1) made Start ask "Who serves first?" and the matrix tennis pad adapter tapped
Start once; fixed in `lib/pads/tennis.ts` (the home toss chip, a judged two-row fallback).

**L2** (W4: 42 works, 6 red, 282 no path; now 47 works, 0 red, 207 no path)

| move | n | class | cause |
|---|---|---|---|
| `group_group_ko\|football` R4a, M1 red -> works | 2 | (a) W5, harness | `planL2` drives a run on a card-reached cell through the card (`layers.ts`); planned plain, the browser driver refused it (`DriverMisuse`) |
| `group_group_ko\|football` F1 red -> no_path W5 | 1 | (a) W5, harness | F1 seeds an odd field and a card seeds its own 16 (`NoFieldSize`); no screen reaches it, the refusal F1 owes is the L3 case's |
| `group_only` re-seated from football to cricket: football R4a, M1, F1 red (and D4a later, D4b refused) removed, cricket R4a, M1, F1 works (and D4a, D4b, 5 no path) added | 3 + 2 + 10 | (b) expected | removing `triple_rr` re-seated the committed pair runs (the lap shift); the football reds were the same three cells W4 held red |
| `triple_rr` runs removed (no_path 81 across cricket, generic, football, badminton) and the not_run runs re-seated (89 out, 89 in) | 81 / 89 | (b) expected | ruling 287 (T16) |

**L3** (W4: 789 works, 62 red; now 744 works, 11 refused, 51 red)

| move | n | class | cause |
|---|---|---|---|
| `group_group_ko` F1 red -> **refused** (every sport) | 11 | (b) expected | T12 / T12b: the product refuses the field by name (the cut gate answers first: `RR_CUT_EXCEEDS_FIELD`, 8 from a supply of 4) and F1 judges that refusal on its own numbers |
| `triple_rr` removed (46) and 6 cricket `test` variants renumbered | 52 | (b) expected | ruling 287 (T16); the cricket pairwise cover seats `test` cases on the rows that remain. All in `expected-skips-L3.json`, 0 unexpected |
| 7 cricket `test` variants added | 7 | (b) expected | the same renumbering; all works |
| 51 reds left: americano R4 x10, mexicano LIFECYCLE x11 / M1 x10 / R4 x10 / F1 x10 | 51 | unchanged | the same ids as the W4 baseline, in kind (62 less the 11 F1 above) |

Zero state moves across the 799 L3 cases both runs hold except the 11 F1 moves; zero regressions in any layer.

## Reproduce
```
pnpm matrix:judge regression --baseline truth-runs/w4-final/ci/<L>/results.json --now truth-runs/w5-app-a/ci/<L>/results.json \
  --expect truth-runs/w5-app-a/expect-<L>.json --expected-skips truth-runs/w5-app-a/expected-skips-<L>.json --json-out judge-<L>.json
pnpm matrix:lock-check --against HEAD^1
```

## Coverage that moved off the matrix (RB5-E4, the pool of one)

After T12b the cut gate answers first on the one row that reaches it (`group_group_ko` with F1's 7 entrants: a top 2 of each of 4 pools is 8, the
field supplies 4: a rank wave is all or nothing in the engine), so **no live matrix cell exercises the pool-of-one gate (RB5-E4, 422 `STAGE_NOT_READY`
`group_too_few_entrants`) any more**. F1 still judges it if a product ever answers with it (`poolItems`, `f1-pool-of-one.test.ts`), but nothing on the
grid reaches it. It is covered by `apps/web/src/server/usecases/__tests__/pool-size-gate.test.ts` (real Postgres: "X-BD-1 7/4 -> 422 STAGE_NOT_READY with
suggested 3, and nothing written", plus the 3/2, 2/4 and withdrawal cases) and the pure rule's own sweep, `apps/web/src/lib/__tests__/pool-size-gate.test.ts`.
A grid row that seats a pool of one without tripping the cut gate (a smaller field, or a lower cut) would restore the live cell.

## Swapping this run for the next one

The swap list, so none of it is rediscovered: replace `ci/`; regenerate `expect-<L>.json` (the run's ids) and `expected-skips-<L>.json` (the baseline's ids it
lacks) and `judge-<L>.json`; regenerate the lock entries for `w5-app-a/ci/<L>` (`freeze(plan)`, `__tests__/committed-plans.ts`; an entry already on `main`
is append-only, so a NEW run takes a new directory); update the run-id pins in `baseline-w5.test.ts` and `baseline-ruling70.test.ts` (and its 806 count);
re-check the `pr-sample.test.ts` "7 lacked by w4 / reseated []" pins.
