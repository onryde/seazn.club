# W1d baseline: the harness-green verdict (ruling 61)

Harness-green is mechanical (ruling 61, design 6.5): no harness fault in any run, and every case in the same state in every run. It is judged by `pnpm matrix:judge across` over three workflow runs of one product. The three runs are the three dispatches of the pinned tag `matrix-truth/w1d-baseline` (commit 47f210e3f2094405e4ed4c8b5c9ea6bd2a6085d9, the tip of `main` after PR-A), so a state that differs between them is nondeterminism of the product or the harness, never "main moved" (D21). The harness commit every results.json records is `47f210e`.

## Verdict (owner ruling 70, 2026-10-05)

- **L1 is harness-green**: 231 cases, three runs, 0 differing, 0 faults.
- **L2 is harness-green**: 1731 cases, three runs, 0 differing, 0 faults.
- **L3 is harness-green except exactly three named cases**: 937 cases, three runs, 0 faults, and 3 cases whose state differs. The cause is the product's lots tiebreak (a UUID-hashed draw, by design) exposing P6 / SW-H1 (a Swiss round 5 that pairs nobody is reported as success). Which sport's draw lands badly varies from run to run, so the three cells are red in some runs and works in others:
  - `swiss_knockout|football|11-a-side|R4`
  - `swiss_knockout|carrom|club-29|R4`
  - `swiss_knockout|generic|score|R4`

The harness is not at fault. Every red of the three cells, in whichever run it was red, has the same reason: `I4-nothing-ends-stuck: stage 1: round 5 paired nobody (SW-H1); life-loop-bounded: play loop exited empty_pair_round`. The other cells of the same row and scenario do not flip: cricket, volleyball, badminton, tabletennis, tennis and icehockey are works in all three runs; hockey (the same SW-H1 reason) and boardgame (a drawn game that stalls the second stage) are red in all three. The baseline records the three cells RED with cause P6 (worst observed state): `tools/matrix/catalogue/baseline.json` carries them as its `ruling70` list, and `judge regression` reads the baseline that way, so a later works on them is an improvement and a later red is no change. No harness fix and no further dispatch is owed; the dispatch count is closed at three.

## The three dispatches

| dispatch | workflow run | wall | L1 | L2 | L3 |
|---|---|---|---|---|---|
| 1 | 37341165564 | 19.5 min | works 155, red 23, no_path 53 | works 40, red 22, no_path 164, not_run 1505 | works 772, red 165 |
| 2 | 37343825825 | 18.1 min | works 155, red 23, no_path 53 | works 40, red 22, no_path 164, not_run 1505 | works 773, red 164 |
| 3 | 37346206686 | 19.9 min | works 155, red 23, no_path 53 | works 40, red 22, no_path 164, not_run 1505 | works 773, red 164 |

All fifteen jobs of each run finished `success`; none was cancelled. The third run's merged results are the committed L1, L2 and L3 beside this file.

## `matrix:judge across`, verbatim

Arguments: the three runs' merged `results.json` of one layer, in dispatch order. Exit codes are the harness's own (D8): 0 is a clean verdict, 1 a negative signal.

### L1

```text
L1: compared 231 cases across 3 runs; 0 differing; 0 faults
exit 0: done — a verdict or data was written
```

### L2

```text
L2: compared 1731 cases across 3 runs; 0 differing; 0 faults
exit 0: done — a verdict or data was written
```

### L3

```text
L3: compared 937 cases across 3 runs; 3 differing; 0 faults
  differing swiss_knockout|football|11-a-side|R4: red, works, red
  differing swiss_knockout|carrom|club-29|R4: red, works, works
  differing swiss_knockout|generic|score|R4: works, red, works
exit 1: a negative signal: a difference, drift, zero cases, a regression, a harness fault
```

## `matrix:judge faults`, verbatim

Arguments: each merged `results.json` with `--planned-not-run allow` (ruling 65: a planned case that did not run is not a fault; a not_run on a driven case still is). The merge job of every run produced these; they are the same files the run's summary page binds to each layer.

### Dispatch 1, L1

```text
L1 ci-37341165564-1-l1 (--layer L1 --scope grid): compared 231 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 1, L2

```text
L2 ci-37341165564-1-l2 (--layer L2 --scope grid): compared 1731 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 1, L3

```text
L3 ci-37341165564-1-l3 (--set w1-driving): compared 937 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 2, L1

```text
L1 ci-37343825825-1-l1 (--layer L1 --scope grid): compared 231 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 2, L2

```text
L2 ci-37343825825-1-l2 (--layer L2 --scope grid): compared 1731 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 2, L3

```text
L3 ci-37343825825-1-l3 (--set w1-driving): compared 937 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 3, L1

```text
L1 ci-37346206686-1-l1 (--layer L1 --scope grid): compared 231 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 3, L2

```text
L2 ci-37346206686-1-l2 (--layer L2 --scope grid): compared 1731 cases; 0 faults
exit 0: done — a verdict or data was written
```

### Dispatch 3, L3

```text
L3 ci-37346206686-1-l3 (--set w1-driving): compared 937 cases; 0 faults
exit 0: done — a verdict or data was written
```
