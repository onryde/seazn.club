# W4 truth run (W4 knockout app B, Task 17)

CI run **42992170592** (`matrix-truth.yml`, `scope=full`, `workflow_dispatch`), harness commit `c9da3dad09` (app B head `e7f26eb787` minus
test-only commits; product tree identical), artifact `merged`, 0 harness faults in any layer. Evidence in `ci/`; `matrix:render` output is
byte-identical to `ci/<L>/MATRIX.md`. (`faults.txt` is not committed: committed-matrix does not read it; `ci/<L>/judge.json` carries the verdict.)
The first W4 run (42907051788, harness `d26ef83f4c`) held 34 ko_plate regressions that proved to be a driver fault (playDivision drove the old
plate model, fixed by `54ecfd2b2e`); it is superseded and not committed.

| layer | cases | works | refused | red | later | no path | planned |
|---|---|---|---|---|---|---|---|
| L1 | 207 | 147 | 0 | 19 | 0 | 41 | 0 |
| L2 | 1589 | 42 | 27 | 6 | 16 | 282 | 1216 |
| L3 | 851 | 789 | 0 | 62 | 0 | 0 | 0 |

## Judges (baseline = `../w3-final/ci/<L>/results.json`, `--expected-skips` = the baseline rows the run no longer holds)

| layer | EXIT | compared | skipped (all expected) | regressions |
|---|---|---|---|---|
| L1 | 0 | 207 | 22 | 0 |
| L2 | 0 | 1579 | 150 | 0 |
| L3 | 0 | 851 | 79 | 0 |

Skipped = `page_playoff_only` and `stepladder_only` (L3 34+45, L1 11+11, L2 70+70), refused standalone since W4 T16 (RB4-S6, ruling 269), plus
10 L2 `knockout_third_place|...|Q3@<w>` cells.

## The 33 W4 baseline reds (measured from w3-final L3)

- `ko_plate` F1 x11: red -> **works** (11 of 11). ko_plate is now 12 LIFECYCLE / 11 M1 / 11 R4 / 11 F1 works, no red.
- `stepladder_only` R4 x11 and `page_playoff_only` R4 x11: **absent** (22 of 22) — not cases any more (ruling 269), not a refused verdict.

L3 reds left (62), all in the baseline already and unchanged in kind: `group_group_ko` F1 x11 (C38, 409 STAGE_COMPLETED_SEEDING_FAILED, pre-existing
on main), `americano` R4 x10, `mexicano` LIFECYCLE x11 / M1 x10 / R4 x10 / F1 x10.

## Reproduce
```
pnpm matrix:judge regression --baseline truth-runs/w3-final/ci/<L>/results.json --now truth-runs/w4-final/ci/<L>/results.json \
  --expect truth-runs/w4-final/expect-<L>.json --expected-skips truth-runs/w4-final/expected-skips-<L>.json --json-out judge-<L>.json
pnpm matrix:lock-check --against HEAD
```
