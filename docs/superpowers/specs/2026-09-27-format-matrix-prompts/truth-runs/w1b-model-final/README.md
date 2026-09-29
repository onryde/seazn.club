# W1b model: final run at HEAD

This is the model's final live run over the six slice cells: rows league, knockout and swiss, each with the sports generic and badminton. Fences were on. The harness was at `e9cda4a38` with a clean tree. The run went against a local production build whose `apps/` and `packages/` match that commit. Each seed is FNV-1a of `${runId}|${cell}`.

| file | run id | cells | runs | exit | verdict |
|---|---|---|---|---|---|
| `model-report.json` | `w1b-model-final` | league\|generic, league\|badminton, knockout\|generic, knockout\|badminton, swiss\|generic | 20 (default) | 0 | 4 ok, 1 known (MB-005), 0 NEW |
| `model-report-swiss-badminton-40.json` | `w1b-model-final-sb40` | swiss\|badminton, `--seed -2002771143` | 40 | 0 | ok, 0 NEW |
| `model-report-regressions.json` | `w1b-model-final-regressions` | `--regressions`: MB-001 to MB-005 | replay | 0 | 5 known, every case replays exactly |
| `model-report-knockout.json` | `w1b-model-final-ko` | knockout\|generic, knockout\|badminton | 20 (default) | 0 | 2 ok, 20/20 runs each, 0 NEW |
| `model-report-regressions-ko.json` | `w1b-model-final-ko-regressions` | `--regressions`: MB-001 to MB-005 | replay | 0 | 5 known, identical to `model-report-regressions.json` |

## The knockout cells, re-run (final batch F-1)

`model-report-knockout.json` replaces the two knockout cells of `model-report.json`. There, knockout\|badminton stopped at its known MB-005 after 2 of 20 runs, and Rebuild never ran. The cell was vacuous, but the model did not judge vacuity on a cell whose failure was known. It now does, and fences steer the walk off the committed knockout bugs: `ko-withdraw-waiting-on-tbd` (MB-002/003) and `ko-generate-after-roster-change` (MB-004/005). The re-run used harness `15d434d35` with a clean tree. The local production build was made at `d8186ae24`; between the two commits, `apps/` and `packages/` differ only in `packages/reference/test/boundary-gate.test.ts`, which the app does not load. Both cells ran 20 of 20 runs, every command kind ran, and neither cell was vacuous. The fences fired 16 times on knockout\|generic and 8 times on knockout\|badminton. `--regressions` at the same commit replays all five cases exactly.

## Why swiss|badminton runs at 40

At the default 20 runs, fix round 1's seed for this cell never drew a Correct. The cell was therefore vacuous on coverage and exited 1. That verdict was correct, but the cell proved nothing about corrections. The same seed at 40 runs was ok (w1b-model-fr1, 0929g). The cause is Swiss itself: a result needs Start, then a Generate that pairs a round, then a Score, so a Correct comes late in a command sequence.

This run uses `--seed -2002771143`, the seed that `w1b-model-final` would have derived for the cell. The only difference from the other five cells is the run count. At 40 runs every command kind ran: Correct 6, Void 4, Score 9 and Walkover 6.
