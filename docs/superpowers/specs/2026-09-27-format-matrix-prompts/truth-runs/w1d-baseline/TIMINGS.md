# W1d baseline: measured times

Design section 12: "W1d publishes the real times". These are the numbers the shard budgets (`tools/matrix/ci/shards.json`) and the weekly run's expected duration rest on. Nothing here is a count, so `tools/matrix/catalogue/counts.json` gains nothing.

Sources, so a reader can redo them:

- **Per-case time**: `durationMs` of each driven case in the dispatch's merged `results.json`. A planned (no_path / not_run) case has `durationMs` 0 and is no measurement, so only driven cases are counted. p50 and p90 are nearest-rank percentiles (`percentile` in `tools/matrix/ci/summary.ts`, the same function the weekly summary page uses); max is the largest value.
- **Per-shard cases**: a shard runs a stripe of the plan, item i of the plan to shard (i mod N) + 1 (`tools/matrix/lib/shard.ts`). The merged results hold the cases in plan order, so each shard's cases are recovered from them.
- **Wall clock**: GitHub's jobs API (`gh api repos/onryde/seazn.club/actions/runs/<run>/jobs`). A shard's wall is its job's `started_at` to `completed_at`, which includes setup (checkout, install, build download, migrations, sports sync, browser install, server start) as well as the cases. A layer's wall is its first shard job's start to its last shard job's end. The run wall is the workflow run's `run_started_at` to its `updated_at` (plan, build, every shard, merge).
- L1 and L2 run one worker per shard. L3 runs four workers per shard, so its driven time sums to more than the shard's wall.

## The three dispatches

| dispatch | workflow run | run wall | L1 wall | L2 wall | L3 wall |
|---|---|---|---|---|---|
| 1 | 37341165564 | 19.5 min | 14.1 min | 14.0 min | 8.5 min |
| 2 | 37343825825 | 18.1 min | 13.8 min | 14.7 min | 9.9 min |
| 3 | 37346206686 | 19.9 min | 14.6 min | 15.6 min | 8.9 min |

## Per layer, driven cases only

| dispatch | layer | shards | driven | p50 | p90 | max |
|---|---|---|---|---|---|---|
| 1 | L1 | 8 | 178 | 18.4 s | 90.3 s | 127.4 s |
| 1 | L2 | 2 | 62 | 14.8 s | 22.9 s | 119.3 s |
| 1 | L3 | 2 | 937 | 2.8 s | 6.8 s | 11.3 s |
| 2 | L1 | 8 | 178 | 18.8 s | 90.2 s | 129.2 s |
| 2 | L2 | 2 | 62 | 15.0 s | 23.6 s | 123.1 s |
| 2 | L3 | 2 | 937 | 2.7 s | 6.5 s | 14.8 s |
| 3 | L1 | 8 | 178 | 18.7 s | 90.8 s | 128.4 s |
| 3 | L2 | 2 | 62 | 16.2 s | 23.8 s | 126.5 s |
| 3 | L3 | 2 | 937 | 2.6 s | 6.3 s | 11.2 s |

## Per shard, dispatch 1 (workflow run 37341165564; its merged artifact is not committed)

| layer | shard | items | driven | p50 | p90 | max | job wall |
|---|---|---|---|---|---|---|---|
| L1 | 1/8 | 29 | 22 | 17.5 s | 27.3 s | 120.4 s | 11.5 min |
| L1 | 2/8 | 29 | 22 | 18.0 s | 29.6 s | 127.4 s | 11.8 min |
| L1 | 3/8 | 29 | 22 | 18.5 s | 29.3 s | 119.2 s | 11.8 min |
| L1 | 4/8 | 29 | 22 | 18.8 s | 90.3 s | 118.4 s | 13.3 min |
| L1 | 5/8 | 29 | 23 | 19.1 s | 118.7 s | 125.9 s | 13.8 min |
| L1 | 6/8 | 29 | 22 | 13.9 s | 22.0 s | 116.9 s | 10.1 min |
| L1 | 7/8 | 29 | 23 | 17.8 s | 33.6 s | 119.9 s | 12.1 min |
| L1 | 8/8 | 28 | 22 | 18.4 s | 34.0 s | 121.7 s | 11.8 min |
| L2 | 1/2 | 866 | 30 | 14.6 s | 23.4 s | 119.3 s | 14.0 min |
| L2 | 2/2 | 865 | 32 | 15.0 s | 22.1 s | 25.6 s | 10.3 min |
| L3 | 1/2 | 469 | 469 | 2.7 s | 6.0 s | 9.3 s | 7.4 min |
| L3 | 2/2 | 468 | 468 | 2.8 s | 7.4 s | 11.3 s | 8.3 min |

## Per shard, dispatch 2 (workflow run 37343825825; its merged artifact is not committed)

| layer | shard | items | driven | p50 | p90 | max | job wall |
|---|---|---|---|---|---|---|---|
| L1 | 1/8 | 29 | 22 | 19.2 s | 29.1 s | 122.5 s | 12.0 min |
| L1 | 2/8 | 29 | 22 | 18.0 s | 30.5 s | 129.2 s | 12.2 min |
| L1 | 3/8 | 29 | 22 | 18.8 s | 30.6 s | 119.7 s | 12.0 min |
| L1 | 4/8 | 29 | 22 | 20.0 s | 90.2 s | 120.3 s | 13.8 min |
| L1 | 5/8 | 29 | 23 | 14.4 s | 112.4 s | 118.4 s | 11.9 min |
| L1 | 6/8 | 29 | 22 | 18.9 s | 27.1 s | 126.3 s | 12.2 min |
| L1 | 7/8 | 29 | 23 | 17.9 s | 34.4 s | 119.8 s | 12.1 min |
| L1 | 8/8 | 28 | 22 | 17.9 s | 34.0 s | 122.2 s | 11.7 min |
| L2 | 1/2 | 866 | 30 | 15.1 s | 25.1 s | 123.1 s | 14.7 min |
| L2 | 2/2 | 865 | 32 | 14.8 s | 22.2 s | 25.0 s | 10.1 min |
| L3 | 1/2 | 469 | 469 | 2.1 s | 5.1 s | 7.3 s | 6.2 min |
| L3 | 2/2 | 468 | 468 | 3.7 s | 8.2 s | 14.8 s | 9.9 min |

## Per shard, dispatch 3 (workflow run 37346206686, the committed baseline)

| layer | shard | items | driven | p50 | p90 | max | job wall |
|---|---|---|---|---|---|---|---|
| L1 | 1/8 | 29 | 22 | 19.2 s | 29.1 s | 122.2 s | 12.1 min |
| L1 | 2/8 | 29 | 22 | 17.3 s | 29.6 s | 127.0 s | 11.7 min |
| L1 | 3/8 | 29 | 22 | 14.5 s | 24.6 s | 113.2 s | 10.1 min |
| L1 | 4/8 | 29 | 22 | 19.2 s | 90.8 s | 119.0 s | 13.2 min |
| L1 | 5/8 | 29 | 23 | 20.8 s | 119.9 s | 128.4 s | 14.6 min |
| L1 | 6/8 | 29 | 22 | 18.9 s | 27.1 s | 125.7 s | 12.2 min |
| L1 | 7/8 | 29 | 23 | 17.1 s | 32.1 s | 118.9 s | 11.5 min |
| L1 | 8/8 | 28 | 22 | 18.6 s | 34.1 s | 122.2 s | 11.9 min |
| L2 | 1/2 | 866 | 30 | 17.3 s | 26.2 s | 126.5 s | 15.6 min |
| L2 | 2/2 | 865 | 32 | 14.9 s | 22.0 s | 23.8 s | 10.0 min |
| L3 | 1/2 | 469 | 469 | 3.4 s | 7.7 s | 11.2 s | 8.9 min |
| L3 | 2/2 | 468 | 468 | 2.0 s | 4.8 s | 7.6 s | 5.8 min |

## What the shard budgets do with these numbers (Task 21, step 4)

`tools/matrix/ci/shards.json` derives each job's timeout as setup (18 min) + ceil(driven items in the stripe x ceiling x passes / workers / 60) + slack (10 min), where a layer's ceiling is the largest per-case time any run named in `ceilingFrom` measured, rounded up to 10 s, times 1.5. Each layer's `ceilingFrom` now names the committed baseline (`w1d-baseline/L1`, `L2`, `L3`); only the third dispatch is committed, and the other two would not have moved a ceiling (the largest per-case time of any dispatch rounds up to the same 10 s: L1 129.2 s and L2 126.5 s to 130 s, L3 14.8 s to 20 s).

| layer | ceiling before | ceiling now | job timeouts before | job timeouts now | longest shard job measured |
|---|---|---|---|---|---|
| L1 | 210 s (the W1-driving L1 runs) | 195 s | 105 to 109 min | 100 to 103 min | 14.6 min |
| L2 | 30 s (the W1c slice run) | 195 s | 43 to 44 min | 126 to 132 min | 15.6 min |
| L3 | 30 s | 30 s | 87 min | 87 min | 9.9 min |

No derived timeout comes near the 300-minute cap (the largest is 132 min), so no layer was re-sharded. L2's ceiling moved most: the full L2 grid drives 62 cases at up to 126.5 s each, where the W1c slice run it was derived from measured nothing above 20 s. The timeouts are the formula's worst case (every driven case at the 1.5x ceiling, plus setup and slack), several times the measured walls: they bound a hung job, they do not predict a run. The measured weekly duration is the run wall above, about 20 minutes, set by the slowest shard of the browser layers.
