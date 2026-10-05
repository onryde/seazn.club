# W1d baseline: the first full L1 / L2 / L3 truth run

The committed record of the first complete run of the format x sport matrix on CI (W1d, ruling 63, D19): every layer, every cell, three times over, then every red keyed to a gap. It is the baseline the per-PR sample is judged against (`tools/matrix/catalogue/baseline.json` names `L3/results.json` here) and the per-case ceiling the shard budgets derive from (`tools/matrix/ci/shards.json`).

The committed `L1`, `L2` and `L3` are the merged results of the THIRD of three dispatches. The other two are not committed (one reviewable baseline instead of three copies); their states are in `HARNESS-GREEN.md`, the 14 L3 cases in which they differ from the third beyond a number are in `dispatch-cuts.json` (see "What differs between the three dispatches"), and their workflow runs are named below.

## The run

| | |
|---|---|
| tag | `matrix-truth/w1d-baseline`, a lightweight tag on commit `47f210e3f2094405e4ed4c8b5c9ea6bd2a6085d9` (the tip of `main` after PR-A, #921) |
| what it deploys | nothing: no workflow triggers on a tag outside `v*.*.*` (D21) |
| harness commit | `47f210e` (what every results.json records as `harnessCommit`) |
| workflow | `Matrix truth run` (`.github/workflows/matrix-truth.yml`), dispatched three times with `--ref matrix-truth/w1d-baseline` |
| dispatch 1 | workflow run 37341165564 |
| dispatch 2 | workflow run 37343825825 |
| dispatch 3 | workflow run 37346206686 (the committed baseline) |
| runner | GitHub-hosted `ubuntu-latest`, Node 26, pnpm |
| database | one fresh `postgres:16` service container per shard job, migrations applied and `sync:sports` run; no Redis |
| scorepad hold | `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` (HOLD 3000), baked into the one standalone build and set on every job |
| server | the standalone build, made once (`Build once`) and started on each shard; Chromium installed per shard; no solver service (ruling 66); no Playwright trace (D16) |
| workers | L1 and L2 one per shard; L3 four per shard |
| orgs and people | synthetic only; the repository is public |
| artifact retention | 90 days: the shard and `merged` artifacts of the three runs expire on 2027-01-03; the `build` artifact expires after one day |

## The three layers, as committed

| layer | plan | run id | shards | cases | driven | works | red | no_path | not_run |
|---|---|---|---|---|---|---|---|---|---|
| L1 | `--layer L1 --scope grid` | `ci-37346206686-1-l1` | 8 | 231 | 178 | 155 | 23 | 53 | 0 |
| L2 | `--layer L2 --scope grid` | `ci-37346206686-1-l2` | 2 | 1731 | 62 | 40 | 22 | 164 | 1505 |
| L3 | `--set w1-driving` | `ci-37346206686-1-l3` | 2 | 937 | 937 | 773 | 164 | 0 | 0 |

A layer's `MATRIX.md` is the render of its `results.json` (`merge-shards` writes both; never edit either by hand). The three layers are frozen in `../plans.lock.json` as `w1d-baseline/L1`, `w1d-baseline/L2` and `w1d-baseline/L3`, so a later planner change cannot redden them.

## What differs between the three dispatches

Measured from the three dispatches' merged results (the same 231, 1731 and 937 cases in the same plan order in all three). A reason "differs beyond ids and numbers" when it still differs after every UUID is replaced by `<id>` and every number by `<n>`.

| layer | cases | state differs | failing-check set differs | reason differs beyond ids and numbers | reason differs only in a number |
|---|---|---|---|---|---|
| L1 | 231 | 0 | 0 | 0 | 5 |
| L2 | 1731 | 0 | 0 | 0 | 1 |
| L3 | 937 | 3 | 12 | 14 | 11 |

L1 and L2 are stable in state and in what fails. The L3 cases that differ beyond a number are 14, in three groups, all red in every dispatch except the first group:

- **State (3), owner ruling 70, below**: `swiss_knockout|football|11-a-side|R4`, `swiss_knockout|carrom|club-29|R4`, `swiss_knockout|generic|score|R4`.
- **Failing-check set, state red in all three (9)**: `mexicano|<sport>|R4` for the nine sports football 11-a-side, boardgame blitz, carrom club-29, volleyball beach, badminton bwf, tabletennis bo5, tennis tour, icehockey iihf and hockey fih-outdoor. The failure is one of two shapes, and a cell changes shape between dispatches: `I10-americano-seats-each-person-once` (a person seated twice in a round) with `r4-not-seated-later` (a round that seats withdrawn people), or `generate answered 500 INTERNAL` (`I4-nothing-ends-stuck`, `I8-generate-named`, `life-loop-bounded`), or both at once. The other two mexicano R4 cells, cricket t20 and generic score, do not change shape. States are stable, so ruling 61 and the judge are unaffected, and triage keys every shape (0 untriaged). It does mean the product's mexicano `generate` answers 500 INTERNAL in some runs and not others on the same plan.
- **Reason only, state red and failing checks the same (2)**: `swiss_playoff|boardgame|blitz|R4` and `swiss_playoff|generic|score|R4` (the REASON flips between SW-H1 and the drawn-game stall; see below).

A further 17 cases differ only in a number inside an otherwise identical reason (a millisecond count, the round a double seating fell in): the 11 L3 cells `mexicano|<every sport>|F1`, the 5 L1 cells `groups_ko|boardgame|blitz|LIFECYCLE@1280`, `mexicano|football|11-a-side|LIFECYCLE@1280`, `mexicano|cricket|t20|LIFECYCLE@1280`, `mexicano|volleyball|beach|LIFECYCLE@1280` and `mexicano|hockey|fih-outdoor|LIFECYCLE@1280`, and the one L2 cell `mexicano|football|11-a-side|F1@430`. Dispatches 1 and 2 are not committed, so the L1, L2 and number-only counts are what the three merged artifacts held when this was committed (they expire 2027-01-03); the 14 L3 cases of the three groups are re-derived from `dispatch-cuts.json` by a test.

## Files

| file | what it is |
|---|---|
| `L1/`, `L2/`, `L3/` | `results.json` and `MATRIX.md` of the third dispatch's merged run |
| `HARNESS-GREEN.md` | the verdict (ruling 61 with owner ruling 70) and the three `judge across` outputs, verbatim, with every dispatch's `judge faults` |
| `dispatch-cuts.json` | the 14 L3 cases whose state, failing-check set or reason differs between the three dispatches beyond a number (ruling 70's three, nine `mexicano|*|R4` cells and two `swiss_playoff|*|R4` cells), as each of the three dispatches recorded them |
| `TRIAGE.md` | every red of the three layers keyed to one audit gap or one new gap, with its design section 8 wave (209 reds, 0 untriaged) |
| `REKEY.md` | the W1-driving P-rule reds, each with the gap it now has |
| `AUDIT-LEDGER.md` | all 150 audit ids, each with exactly one of five outcomes |
| `TIMINGS.md` | per layer and per shard: wall clock and per-case p50, p90, max; what the shard budgets derive from them |

`TRIAGE.md`, `REKEY.md` and `AUDIT-LEDGER.md` are written by `pnpm matrix:triage` and `pnpm matrix:ledger` from the three committed layers and `tools/matrix/catalogue/`; a test regenerates them and compares byte for byte, so a catalogue edit that moves a gap is a visible edit of these files too.

## Owner ruling 70: three cells held red

Across the three dispatches, three L3 cells flipped between works and red. Each red is the same defect: the product's lots tiebreak (a UUID-hashed draw, by design) ends a Swiss round 5 that pairs nobody and the product reports success (P6, audit SW-H1, routed to W3). The ruling accepts L1 and L2 as harness-green and L3 as harness-green except these three, and records them RED with cause P6:

- `swiss_knockout|football|11-a-side|R4`: red, works, red
- `swiss_knockout|carrom|club-29|R4`: red, works, works
- `swiss_knockout|generic|score|R4`: works, red, works

(states per dispatch, in dispatch order). The committed run shows carrom and generic as works, so triage, which keys only reds, cannot hold them; the override is `ruling70` in `tools/matrix/catalogue/baseline.json`, applied by `judge regression` to the baseline it is given. A later run's works on any of the three reads as an improvement and its red as no change; any other case that worked and goes red is a regression as before.

The two `swiss_playoff` cells `swiss_playoff|boardgame|blitz|R4` and `swiss_playoff|generic|score|R4` are red in all three dispatches, so they are no state difference and not part of the ruling. Their REASON flips: dispatch 1 reads `round 5 paired nobody (SW-H1)`, dispatches 2 and 3 read the drawn-game stall (`stage 2: did not complete`). The triage rules separate them by reason.

`TRIAGE.md` and `AUDIT-LEDGER.md` list SW-H1 on three cases (`swiss_playoff|hockey|fih-outdoor|R4`, `swiss_knockout|football|11-a-side|R4`, `swiss_knockout|hockey|fih-outdoor|R4`): the cases that are RED in the committed run for that reason. They share only football with ruling 70, whose carrom and generic cells are works in the committed run and so reach triage only through the override.

The override is bound to this baseline and retires at the re-baseline that follows the fix (the guards below fire then, not when the fix merges). The block records the workflow run, the tag and the tag's commit it was written for (`workflowRun`, `tag`, `tagCommit`), and `catalogue/baseline.json` refuses it (`BaselineUnreadable`, exit 2 from `judge regression`) when the L3 it sits beside is another run, so a re-baselined L3 cannot silently keep forcing the three cells red; handed any other `--baseline`, the judge forces nothing. It also refuses any id list but ruling 70's exact three. A test fails once none of the three cells is red in the committed baseline. **The fix for SW-H1 removes `ruling70` (and `RULING_70_IDS` in `lib/pr-sample.ts`) and re-baselines L3.**

## Screenshots

The merged artifact carries no pictures by design. Each browser shard's own artifact does: `shard-L1-1` to `shard-L1-8` and `shard-L2-1`, `shard-L2-2` of workflow run 37346206686 (and the same names for the other two runs), until 2027-01-03:

    gh run download 37346206686 --repo onryde/seazn.club -n shard-L2-2

Inside: `<run id>-s<N>/results.json` and `<run id>-s<N>/shots/case-N/<label>.png`. `case-N` is 1-BASED: the position of the case in that shard's own `results.json` (the `case-${i + 1}` directory name in `tools/matrix/run.ts`), not a 0-based index. Open the picture to confirm: the page breadcrumb reads `Matrix <row>|<sport>|<variant>|<scenario>`. The new-gap entries in `tools/matrix/catalogue/new-gaps.json` cite one L1 and one L2 picture each, by this path.

## Reproduce

From the repository root (`$OUT` is any empty directory). The two commands regenerate `TRIAGE.md`, `REKEY.md` and `AUDIT-LEDGER.md`; a test runs them as printed and compares the three files byte for byte:

    pnpm matrix:triage --runs docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L1/results.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L2/results.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L3/results.json --rekey docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3/results.json --rekey-map tools/matrix/catalogue/p-map.json --out $OUT
    pnpm matrix:ledger --audit docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27 --triage $OUT/triage.json --verdicts tools/matrix/catalogue/audit-verdicts.json --out $OUT/AUDIT-LEDGER.md

`$OUT/TRIAGE.md` and `$OUT/REKEY.md` are then the committed files of the same names, and `$OUT/AUDIT-LEDGER.md` is `AUDIT-LEDGER.md`.

A sample is judged against the baseline as the per-PR run does it (`--expect` is the JSON list of the case ids the sample planned):

    pnpm matrix:judge regression --baseline docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L3/results.json --now <a later run> --expect <ids.json>

`pnpm matrix:judge across` needs the three dispatches' merged artifacts (`gh run download <run> -n merged`), kept 90 days; its verbatim output is in `HARNESS-GREEN.md`.
