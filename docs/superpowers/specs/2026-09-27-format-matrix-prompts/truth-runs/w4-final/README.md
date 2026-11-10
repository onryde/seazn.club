# W4 truth run (W4 knockout app B, Task 17)

CI run **42907051788** (`matrix-truth.yml`, `scope=full`, `workflow_dispatch`), harness commit `d26ef83f4c` (app B after T16), 15/15 jobs
success, 0 harness faults in any layer. Evidence in `ci/` (the `merged` artifact); `matrix:render` output is byte-identical to `ci/<L>/MATRIX.md`.

| layer | cases | works | refused | red | no path | planned |
|---|---|---|---|---|---|---|
| L1 | 207 | 147 | 0 | 19 | 41 | 0 |
| L2 | 1589 | 39 | 27 | 9 | 282 | 1216 |
| L3 | 851 | 744 | 0 | 107 | 0 | 0 |

## Judges (baseline = `../w3-final/ci/<L>/results.json`, `--expected-skips` = the dropped rows below)

| layer | EXIT | compared | skipped (all expected) | regressions |
|---|---|---|---|---|
| L1 | 0 | 207 | 22 | 0 |
| L2 | 0 | 1579 | 150 | 0 |
| L3 | **1** | 851 | 79 | **34** |

Skipped = baseline cases the run no longer holds: `page_playoff_only` and `stepladder_only` (L3 34+45, L1 11+11, L2 70+70) are refused
standalone since W4 T16 (RB4-S6, ruling 269), and 10 L2 `knockout_third_place|...|Q3@<w>` cells.

## L3: NOT re-baselined (held)

34 regressions, all `ko_plate`: LIFECYCLE x12, M1 x11, R4 x11 went works -> red, `I4-nothing-ends-stuck: stage 2: empty generate (R13)`,
`advance-seeded-as-declared: stage 2: no proposal`. `ko_plate F1` x11 is still red, and `group_group_ko F1` x11, `americano`/`mexicano` reds
are unchanged from the baseline. The ko_plate regressions are under diagnosis (msample lane, harness vs product); `baseline.json` still
names `w3-final`. The 33 W4 baseline reds: ko_plate F1 x11 still red; stepladder_only R4 x11 and page_playoff_only R4 x11 are no longer
cases (refused standalone, ruling 269).

## Reproduce
```
pnpm matrix:judge regression --baseline truth-runs/w3-final/ci/<L>/results.json --now truth-runs/w4-final/ci/<L>/results.json \
  --expect truth-runs/w4-final/expect-<L>.json --expected-skips truth-runs/w4-final/expected-skips-<L>.json --json-out judge-<L>.json
pnpm matrix:lock-check --against HEAD
```
