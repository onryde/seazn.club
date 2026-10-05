# W1d baseline: the first full L1 / L2 / L3 truth run

The committed record of the first complete run of the format x sport matrix on CI (W1d, ruling 63, D19): every layer, every cell, three times over, then every red keyed to a gap. It is the baseline the per-PR sample is judged against (`tools/matrix/catalogue/baseline.json` names `L3/results.json` here) and the per-case ceiling the shard budgets derive from (`tools/matrix/ci/shards.json`).

The committed `L1`, `L2` and `L3` are the merged results of the THIRD of three dispatches. The other two are not committed (one reviewable baseline instead of three copies); their states are in `HARNESS-GREEN.md` and `dispatch-cuts.json`, and their workflow runs are named below.

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

## Files

| file | what it is |
|---|---|
| `L1/`, `L2/`, `L3/` | `results.json` and `MATRIX.md` of the third dispatch's merged run |
| `HARNESS-GREEN.md` | the verdict (ruling 61 with owner ruling 70) and the three `judge across` outputs, verbatim, with every dispatch's `judge faults` |
| `dispatch-cuts.json` | the five L3 cases that differ or flip between dispatches (ruling 70's three and the two swiss_playoff cells below), as each of the three dispatches recorded them |
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

## Screenshots

The merged artifact carries no pictures by design. Each browser shard's own artifact does: `shard-L1-1` to `shard-L1-8` and `shard-L2-1`, `shard-L2-2` of workflow run 37346206686 (and the same names for the other two runs), until 2027-01-03:

    gh run download 37346206686 --repo onryde/seazn.club -n shard-L2-2

Inside: `<run id>-s<N>/results.json` and `<run id>-s<N>/shots/case-N/<label>.png`. `case-N` is 1-BASED: the position of the case in that shard's own `results.json` (the `case-${i + 1}` directory name in `tools/matrix/run.ts`), not a 0-based index. Open the picture to confirm: the page breadcrumb reads `Matrix <row>|<sport>|<variant>|<scenario>`. The new-gap entries in `tools/matrix/catalogue/new-gaps.json` cite one L1 and one L2 picture each, by this path.

## Reproduce

    pnpm matrix:triage --runs docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L1/results.json <the L2 file> <the L3 file> --out <dir>
    pnpm matrix:judge regression --baseline <L3/results.json> --now <a later run> --expect <ids.json>

`pnpm matrix:judge across` needs the three dispatches' merged artifacts (`gh run download <run> -n merged`), kept 90 days; its verbatim output is in `HARNESS-GREEN.md`.
