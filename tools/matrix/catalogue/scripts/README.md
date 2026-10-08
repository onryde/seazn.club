# Catalogue generators (W1d Task 19)

The python that wrote the committed triage catalogue, kept beside what it writes (Task 19 review m9). Run from the repo root.

| script | writes | needs |
|---|---|---|
| `gen-rules.py [out]` | `../triage-rules.json` | nothing (the closed failing sets are inline, taken from the three baseline dispatches) |
| `gen-routing.py [repo] [out]` | `../gap-routing.json` | design section 8 in `docs/superpowers/specs/2026-09-27-format-matrix-design.md` and the audit directory |
| `gen-verdicts.py [out]` | `../audit-verdicts.json` | `../gap-routing.json` (the wave of each verdict is its route, never typed) |
| `build-p-map.py [repo] [out]` | `../p-map.json` (the `--rekey-map` of `pnpm matrix:triage`) | W1-driving's committed `truth-runs/w1drv-l3/TRIAGE.md` and `results.json` |
| `gen-shapes.py [out]` | `../../__tests__/fixtures/triage-shapes.json` | the three baseline dispatches' results (below) |
| `dump.py <dispatch> <layer>` | prints the reds of one dispatch layer, grouped | the dispatches |
| `classify.py` | prints disagreements between the committed rules and a second reading | the dispatches and their triage output |

`gen-rules.py`, `gen-routing.py`, `gen-verdicts.py` and `build-p-map.py` are rebuilt byte for byte by `tools/matrix/__tests__/catalogue-scripts.test.ts`.
A hand edit of a generated file without the same edit in its script fails that test, so edit the script and regenerate:

    python3 tools/matrix/catalogue/scripts/gen-rules.py
    python3 tools/matrix/catalogue/scripts/gen-routing.py
    python3 tools/matrix/catalogue/scripts/gen-verdicts.py
    python3 tools/matrix/catalogue/scripts/build-p-map.py

`gen-shapes.py`, `dump.py` and `classify.py` read `<n>/<layer>/results.json` for the three baseline dispatches (`W1D_DISPATCH=<dir>`)
and, for `gen-shapes.py` and `classify.py`, the `out<n>/triage.json` each `pnpm matrix:triage` wrote (`W1D_TRIAGE_OUT=<dir>`). Task 21 committed
dispatch 3 (`truth-runs/w1d-baseline/L1`, `L2`, `L3`) and, for dispatches 1 and 2, the 14 L3 cases that differ or flip
(`truth-runs/w1d-baseline/dispatch-cuts.json`). `tools/matrix/__tests__/w1d-baseline-evidence.test.ts` stages that layout and runs all three
(`W1D_RUNS=3` limits `classify.py` to the committed dispatch); `gen-shapes.py` must rebuild the cut fixture byte for byte from it. The full
three-dispatch comparison (`classify.py` over 628 reds) needs the dispatches' merged artifacts, which GitHub keeps 90 days.

`classify.py` is a cross-check, not independent mechanism evidence (review m7): it keys `sport == boardgame` to SC-O1 as the rules
do, so agreement shows the rules are self-consistent. The mechanism evidence for the SC-O1/O2 L3 reds is W1-driving's
`truth-runs/w1drv-l3-fr1/draw-counts.json`.
