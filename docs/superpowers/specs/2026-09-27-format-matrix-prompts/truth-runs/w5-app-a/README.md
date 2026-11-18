# W5 truth run (W5 round-robin app PR A, Task 25)

CI run **44395599687** (`matrix-truth.yml`, `scope=full`, `workflow_dispatch` on `feat/w5-round-robin-app-a`), harness commit `552b8d7f0d`, artifact
`merged`. Evidence in `ci/`. **The run is NOT complete** (`Run complete: no`): 12 harness faults, none of them W5's product (below), and it is
committed as the baseline anyway because L3 (the only layer `catalogue/baseline.json` names) holds none. Two harness fixes landed after it
(planL2's template routing, F1's cut refusal): the next truth run replaces this directory's `ci/` and the baseline's pinned run id.

| layer | cases | driven | works | refused | red | later | no path | planned |
|---|---|---|---|---|---|---|---|---|
| L1 | 196 | 186 | 161 | 0 | 25 | 0 | 10 | 0 |
| L2 | 1513 | 48 | 42 | 27 | 6 | 16 | 206 | 1216 |
| L3 | 806 | 806 | 744 | 0 | 62 | 0 | 0 | 0 |

## Judges (baseline = `../w4-final/ci/<L>/results.json`, `--expected-skips` = the baseline rows this run no longer holds)

| layer | EXIT | compared | skipped (all expected) | regressions |
|---|---|---|---|---|
| L1 | 1 | 195 | 12 | 14 (tennis, below) |
| L2 | 1 | 275 | 1314 | 2 (tennis, below) |
| L3 | 0 | 799 | 52 | **0** |

L2's compared count is small on purpose of the record: removing `triple_rr` (77 runs) moved the plain width rotation under 1139 committed runs, so most
L2 ids (which end `@<width>`) no longer match the baseline's. Read width-blind (same row, sport, preset, scenario) L2 moves only the same three
tennis runs (works -> red), nothing else. L3 is the layer the baseline names and its ids carry no width.

## Every fault and every move, classified

| what | count | class | cause |
|---|---|---|---|
| L1 + L2 tennis `stage-complete` click timeouts (swiss, swiss_playoff, swiss_knockout, americano, mexicano, ladder; 6 L1, 3 L2) | 9 | (d) harness, **pre-existing on main** | `94af4e6b27` (11-12, TN-TS-1) made Start ask "Who serves first?" before writing `core.start`; the matrix tennis pad adapter (`lib/pads/tennis.ts`) taps Start once and no ledger row follows (`core.start missing, 0 of 1 row within 15000ms`), so nothing is ever scored and Complete stays disabled. Identical 6 + 3 in main's own truth run 43578195554 (11-14, `1e8dc1d`). **Fixed** in Task 25's fix round 1: `lib/pads/tennis.ts` now answers the toss (the home chip, `pad-dock-chip-home`) and declares the Start a two-row fallback (`tennis.toss`, then `core.start`). Needs a new run to prove live. |
| L1 tennis LIFECYCLE reds that are not timeouts (league, league_ko, groups_ko, group_stepladder, group_playoffs, knockout, ko_plate, qualifying_main, double_elim, knockout_third_place) | 10 | (d) same cause | same run, same cells red in main's 11-14 run. With the six above, **all 14 L1 works -> red moves are tennis**, which the W4 baseline (11-11) predates. |
| L2 `group_group_ko\|football` R4a / M1 / F1: `DriverMisuse ... built through catalog template super-groups` | 3 | (a) W5, harness | `19ee20053a` (T15) made `templateFor("group_group_ko", sport)` reach every sport; `planL2` still planned its driven runs plain, so the browser driver refused them. They were red before (no organiser control, W5) and are red now for another reason: no regression. **Fixed**: `planL2` routes a driven run through its card and keeps its committed id (`layers.ts`, `layers-grid.test.ts`). Needs a new run to prove live. |
| L3 `group_group_ko` F1 x11 still red, not refused | 11 | (a) W5, harness | T12 expected Start to answer the pool of one (422 STAGE_NOT_READY); T12b's cut gate (`refuseFormatTooSmall`) now answers first on that row (a top 2 of each of 4 pools is 8, the field of 7 supplies 7): `RR_CUT_EXCEEDS_FIELD`. The rulebook (RB5-E4, RB5-E6) owes both by name and orders neither, so **F1 now judges whichever it gets on its own numbers** (`f1-odd-field.ts`, `f1-pool-of-one.test.ts`). The old failure (a pool of one drawn, C38) is retired in the committed run (`baseline-w5.test.ts`). The expected red -> refused move lands on the next run. |
| L3 `triple_rr` (46 cases), 6 cricket `test` variants renumbered, 7 added | 52 / 7 | (b) expected | ruling 287 (T16); the cricket pairwise cover seats `test` cases on the rows that remain. All in `expected-skips-L3.json`, 0 unexpected. |
| L1 `group_only` x9 and `group_group_ko` x9 no_path -> works; `group_only\|tennis`, `group_group_ko\|tennis` no_path -> red | 18 / 2 | (b) expected | T14 (group_only has a picker card) and T15 (super-groups reaches group_group_ko on every sport): the cells are driven now. Tennis ones red for the tennis cause above. |
| L1 `ko_plate` x10 red -> works | 10 | (d) main, not W5 | the W4 run's L1 reds were `ui-champion-shown` (the banner wants a champion a plate stage never has); `bbd7ca9cd4` (11-11, after that run) made the champion want skip losers-fed stages. |
| L3 reds left (62): americano R4 x10, mexicano LIFECYCLE x11 / M1 x10 / R4 x10 / F1 x10, group_group_ko F1 x11 | 62 | unchanged | the same 62 ids as the W4 baseline, all in kind unchanged. |

Zero state moves across the 799 L3 cases both runs hold; zero regressions.

## Moves the next truth run owes (do these when the re-dispatched run lands)

The run above was cut before three fixes, so a re-dispatch replaces it. The swap list, so none of it is rediscovered:

1. Replace `ci/` with the new run's merged output, and repoint `catalogue/baseline.json`'s pinned run id.
2. Replace `expect-<L>.json`, `expected-skips-<L>.json` and the `judge-<L>.json` files with the new judge's output.
3. Append the new run's plans to `plans.lock.json` (append-only; never edit an old entry) and re-run `pnpm matrix:lock-check --against HEAD`.
4. Update the run-id pins in `tools/matrix/__tests__/baseline-w5.test.ts` and `baseline-ruling70.test.ts`, and the latter's case count (806 today).
5. **Tighten `baseline-w5.test.ts`'s F1 expectation from `["refused", "red"]` to `refused` only.** The pair is there because this run still holds the 11 `group_group_ko` F1 cells red (the harness expected the pool of one before T12b's cut gate answered first); the fix makes them refused, so the pair would hide a regression back to red.
6. **Re-check the `pr-sample.test.ts` "7 lacked by w4 / reseated []" pins** against the new baseline: they count what this baseline lacks and the planner seats, and the swap moves both.
7. Drop the tennis and `group_group_ko|football` L1/L2 entries from the "not complete" explanation above once the new run is complete (`Run complete: yes`).

## Second run (44411389618, on `ba1794f1a1`): classified, NOT swapped in

L1: 8 red, all red in the W4 baseline too (3 `swiss*|boardgame` builder-posted-as-harness, 5 `mexicano` stalled rounds), 0 faults; the 17 tennis moves
red -> works, so the tennis adapter fix is proved live. L3: 62 red unchanged, 0 faults. L2: 1 fault, `group_group_ko|football|F1@430` NoFieldSize
(the card seeds 16, F1 needs an odd field): the run-1 R4a / M1 reds are works now. **The 11 `group_group_ko` F1 cells were still red** (`supply 4, want 7`):
the harness summed min(n, pool) over the pools, but a rank wave is all or nothing in the engine (`rowAtRank`), so 7 into 2, 2, 2, 1 supplies 4.
Both are fixed in the harness (`f1-odd-field.ts`, `layers.ts`) and need a THIRD run to prove, so this directory still holds run 1 and the swap list
above is done against run 3.

## Coverage that moved off the matrix (RB5-E4, the pool of one)

After T12b the cut gate answers first on the one row that reaches it (`group_group_ko` with F1's 7 entrants: a top 2 of each of 4 pools is 8, the
field supplies 7), so **no live matrix cell exercises the pool-of-one gate (RB5-E4, 422 `STAGE_NOT_READY` `group_too_few_entrants`) any more**.
F1 still judges it if a product ever answers with it (`poolItems`, `f1-pool-of-one.test.ts`), but nothing on the grid reaches it. It is covered
by `apps/web/src/server/usecases/__tests__/pool-size-gate.test.ts` (real Postgres: "X-BD-1 7/4 -> 422 STAGE_NOT_READY with suggested 3, and nothing
written", plus the 3/2, 2/4 and withdrawal cases) and the pure rule's own sweep, `apps/web/src/lib/__tests__/pool-size-gate.test.ts`. A grid row
that seats a pool of one without tripping the cut gate (a smaller field, or a lower cut) would restore the live cell.

## Reproduce
```
pnpm matrix:judge regression --baseline truth-runs/w4-final/ci/<L>/results.json --now truth-runs/w5-app-a/ci/<L>/results.json \
  --expect truth-runs/w5-app-a/expect-<L>.json --expected-skips truth-runs/w5-app-a/expected-skips-<L>.json --json-out judge-<L>.json
pnpm matrix:lock-check --against HEAD
```
