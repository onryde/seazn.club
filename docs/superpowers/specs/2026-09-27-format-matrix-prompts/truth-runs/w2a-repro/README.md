# W2a reproduction: the 77 SC-O reds and NEW-H1, before any fix

The first task of W2a (plan `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md`, Task 1) re-runs the W1d baseline's 77 SC-O reds and drives the NEW-H1 probe on the W2a branch, before any product change. It is the "before" half of the fix: Task 16 judges the "after" against `expect-77.json`.

## The run

| | |
|---|---|
| branch | `feat/format-matrix-w2a`, harness commit `805443544` (what every `results.json` here records as `harnessCommit`); the branch tip was a docs-only plan commit ahead of it when this was committed |
| product change | none |
| database | a fresh Postgres from `seazn-env up --label w2a --all`: Flyway to v430, then `sync:sports`; `show data_directory` printed the label's own datadir (`/tmp/seazn-env/w2a/pg`), exported as `BENCH_EXPECTED_DATA_DIR` for every harness command |
| server | the label's production standalone build, built from this worktree; `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` (the harness reads the served chunk and would have refused a mismatch; none fired) |
| placement service | the label's own was up (the W1d baseline ran with none, ruling 66) |
| baseline | `../w1d-baseline/{L1,L2,L3}/results.json` (workflow run 37346206686) |

## Result

| gap | cases | red again | works | missing |
|---|---|---|---|---|
| SC-O1 | 65 (L1 10, L2 3, L3 52) | **65** | 0 | 0 |
| SC-O2 | 12 (L1 2, L3 10) | **12** | 0 | 0 |
| total | 77 (L1 12, L2 3, L3 62) | **77** | 0 | 0 |

The Step 5 judge, over `L1`, `L2` and `L3` here (exit 0):

    {"expected":77,"found":77,"red":77,"missing":0,"works":[]}

Each of the 77 reproduces the baseline's own failure and not merely a red: the set of failing checks and the reason (with every id and number masked) equal the baseline's for all 77 (`sameFailingChecks 77`, `sameReasonNormalised 77`, 0 differ). Cases that did not reproduce: **none**.

One red in the pair runs is an error red (the harness's `error reds: 1` line): `stepladder_only|boardgame|blitz|R4`, where `POST /api/v1/entrants/<id>/withdraw` answers 422 `WRONG_PHASE` ("fixture has an unassigned entrant (bye/TBD)"). It is not one of the 77 (it is a sibling case of a pair the 77 name, so the pair run drives it), and the baseline has the same error red with the same reason.

## Layout

| dir | what |
|---|---|
| `expect-77.json` | the 77 case ids (sorted), derived by `pnpm matrix:triage` over the baseline, gap `SC-O1` or `SC-O2`. Task 16 judges it |
| `L3/w2a-repro-l3-1` ... `-17` | one run per (row, sport) pair the 62 L3 ids name (17 pairs); each runs every w1-driving scenario of its pair, so the runs hold more cases than the 62 |
| `L1/w2a-repro-l1` | the **default slice** run (Step 4 as the brief wrote it): 6 cases, all `works`, none of them an SC-O case |
| `L1/w2a-repro-l1-s<k>` | the L1 grid stripe `k/64` (11 stripes) |
| `L2/w2a-repro-l2` | the default slice run: 68 cases (3 works, 7 no_path, 58 not_run), none an SC-O case |
| `L2/w2a-repro-l2-s<k>` | the L2 grid stripe `k/64` (3 stripes) |
| `new-h1/report.json` | the Playwright JSON report of `apps/web/e2e/bracket-new-h1.spec.ts` |

| layer | run | shard | cases | driven | SC-O cases | other driven |
|---|---|---|---|---|---|---|
| L1 | `w2a-repro-l1` | (slice) | 6 | 6 | 0 | 6 |
| L1 | `w2a-repro-l1-s7` | 7/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s16` | 16/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s18` | 18/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s25` | 25/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s27` | 27/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s36` | 36/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s38` | 38/64 | 4 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s47` | 47/64 | 3 | 3 | 1 | 2 |
| L1 | `w2a-repro-l1-s49` | 49/64 | 3 | 2 | 1 | 1 |
| L1 | `w2a-repro-l1-s58` | 58/64 | 3 | 2 | 1 | 1 |
| L1 | `w2a-repro-l1-s60` | 60/64 | 3 | 2 | 2 | 0 |
| L2 | `w2a-repro-l2` | (slice) | 68 | 3 | 0 | 3 |
| L2 | `w2a-repro-l2-s2` | 2/64 | 28 | 1 | 1 | 0 |
| L2 | `w2a-repro-l2-s16` | 16/64 | 27 | 2 | 1 | 1 |
| L2 | `w2a-repro-l2-s26` | 26/64 | 27 | 2 | 1 | 1 |

Run shots (`shots/`) are not committed (they are ignored by git at any depth, by ruling). The two unsharded layers' default runs are kept as the evidence for the first deviation below.

## Deviations from the brief, both from false premises (recorded in `_INDEX.md`, "False premises found (W2a)")

1. **Step 4 cannot reach the L1/L2 SC-O cells by `--only`, nor are they in the default slice.** The brief expected the default slice to contain them. It does not: the L1 slice is 6 league/knockout/swiss cells on generic and badminton, and the L2 slice 68 knockout/swiss ones. After Step 4 as written the judge found **62 of 77** (`missing 15`: L1 12, L2 3). `--only` with `--layer L1|L2` is refused outside the slice (`UnknownFilter`, exit 2, nothing written; 13 refusals seen), and `--scope grid` takes no filter. The 15 cells are grid cells, so they were reached by the grid stripe that holds each: `--scope grid --shard <k>/64`. The stripes are in `../w2a-local-selection.json` under `browserShards`. **The plan's Global Constraints local-selection recipe is refused on every L1 and L2 line; later tasks must use the stripes.**
2. **Lock entries for a stripe run are the printed grid entry restricted to the stripe.** The missing-entry failure prints the whole grid plan for a run; against a 4-case stripe `judgeRun` then reds "planned by --layer L1 --scope grid, missing from the run" for every other item. The 14 stripe entries in `../plans.lock.json` are therefore restricted to the stripe; the stripe is computed from the baseline's plan order (item i belongs to shard i mod 64 + 1) and checked both ways against each run's own case ids. The 19 unsharded runs' entries are exactly as printed. `pnpm matrix:lock-check --against HEAD`: 141 compared, 33 added.

Also: the dialog names the brief pinned for the probe (button "Abandon", dialog textbox, dialog button "Abandon") were not the console's. The control is "Abandon…", the dialog's input is `input[name="reason"]` and its submit is "Apply" (the same pair `scoring.spec.ts` drives); the probe uses those. L3 pair runs print `EXIT=0` here, where the brief allowed `EXIT=1` or `EXIT=0`: reds are data (`run.ts` header).

## NEW-H1: reproduced

`apps/web/e2e/bracket-new-h1.spec.ts`, one whole spec file against the label's server (`--project=parallel`, `E2E_PROD_TARGET=1`): `stats` `expected 2` (the two auth setup tests), `unexpected 1`, exit 1.

What the report shows (the `observed` annotation the probe records just before its ruling assertion, and the error):

- semi 1, abandoned from the console's Abandon control: `status: "abandoned"`, `outcome: null` (the API answers null: the `feederIsDead` shape);
- semi 2, started then `core.forfeit` (walkover): `status: "forfeited"`, `outcome: {kind: "award", method: "walkover", winner: <semi 2's winner>}`;
- the final, never played by anyone: `status: "forfeited"`, `outcome: {kind: "award", winner: <semi 2's winner>}`, `home_entrant_id: null`, `away_entrant_id: <semi 2's winner>`;
- the failing assertion is the ruling one, `bracket-new-h1.spec.ts:79` (`expect(after.status).toBe("scheduled")`): `Expected: "scheduled"`, `Received: "forfeited"`. Every earlier assertion, including semi 1 reading `abandoned` with a null outcome, passed.

So an abandoned semi-final does feed the dead-feeder cascade: the final's open seat is stamped as a bye and the other semi-finalist is walked into a won final, which the 2026-09-21 ruling ("stuck and visible") forbids. Task 10 takes its **fix** branch, not the docs-only one.

## Commands

Environment (seazn-local-env; `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, `W` the worktree):

    cd $W && pnpm install --frozen-lockfile
    cd $W && ln -sfn <main>/.env.local .env.local && ln -sfn <main>/apps/web/.env.local apps/web/.env.local
    cd $W && NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 $S up --label w2a --all
    cd $W && eval "$($S env --label w2a)" && psql "$DATABASE_URL" -Atc "show data_directory"      # /tmp/seazn-env/w2a/pg

Step 2, the 77 ids (`B` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline`); the triage printed `2899 cases in 3 runs; 209 reds checked: 209 triaged, 0 untriaged, 0 ambiguous, 0 misrouted, 0 unknown`, and `expect-77.json` is `{"n":77}`, SC-O1 65 (L1 10, L2 3, L3 52) and SC-O2 12 (L1 2, L3 10):

    pnpm matrix:triage --runs $B/L1/results.json $B/L2/results.json $B/L3/results.json --out $OUT
    jq '[.rows[] | select(.gap=="SC-O1" or .gap=="SC-O2") | .caseId] | sort' $OUT/triage.json > expect-77.json

Step 3, the L3 pairs (17, one run each, workers 4, every line `EXIT=0`):

    pnpm matrix:l3 --set w1-driving --only "<row>|<sport>" --workers 4 --run-id w2a-repro-l3-<i> --report-dir $OUT/L3

Step 4, as the brief wrote it (a slice run that contains no SC-O case) and as it had to be done (stripes):

    pnpm matrix:browser --layer L1 --run-id w2a-repro-l1 --report-dir $OUT/L1
    pnpm matrix:browser --layer L2 --run-id w2a-repro-l2 --report-dir $OUT/L2
    pnpm matrix:browser --layer L1 --scope grid --shard <k>/64 --run-id w2a-repro-l1-s<k> --report-dir $OUT/L1    # k in 7 16 18 25 27 36 38 47 49 58 60
    pnpm matrix:browser --layer L2 --scope grid --shard <k>/64 --run-id w2a-repro-l2-s<k> --report-dir $OUT/L2    # k in 2 16 26

(every L1 and L2 line printed `EXIT=0`, with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` and `BENCH_EXPECTED_DATA_DIR` exported.)

Step 7, the probe:

    cd $W/apps/web && PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 PLAYWRIGHT_JSON_OUTPUT_NAME=<abs>/new-h1/report.json npx playwright test --project=parallel e2e/bracket-new-h1.spec.ts --reporter=json

Evidence integrity: `tools/matrix/__tests__/committed-matrix.test.ts` (see the task report for its counts).

## Edits after the repro (phase 3 review of lane P1, fix round 1)

The repro runs above are untouched; the files Task 16 reads were corrected as the plan moved under them.

- **`expect-77.json`, one id re-keyed: `league_ko|boardgame|blitz|F1@834` is now `league_ko|boardgame|blitz|F1@430`.** The L2 grid plan re-widthed that cell (W2a's own bracket cells moved some L2 widths), so Task 16's judge would have reported the old id as *missing* - a refusal that reads like a product defect. Every id is held against today's planners by `tools/matrix/__tests__/w2a-expect.test.ts` (77 of 77 found, 0 missing). The other 76 ids are untouched. The same re-width is why the L2 stripes in `../w2a-local-selection.json` are now `[2, 14, 26]` (was 16) over a plan of 1729 items (was 1731).
- **`expect-77-rekeys.json`, new (controller ruling D-P2).** Six boardgame L3 cells stay in the 77 but are not W2a's to turn green: five R4 cells (knockout, knockout_third_place, double_elim, ko_plate, qualifying_main) re-keyed SC-O1 -> CD-T13 (W2b, BG-WO-2), pinned reason `forfeit not allowed in phase "pre"`; and the ko_plate F1 cell SC-O1 -> FX-G14 (W4), pinned reason `STAGE_COMPLETED_SEEDING_FAILED`. `tools/matrix/w2a-expect.ts` is the judge that reads both files: 71 works + those 6 red for their pinned reasons passes; any other red, or one of the six red for another reason, fails.
- **`expect-77-rekeys.json`, each re-key also pins `failing` (review minor 1).** The reason is matched over everything a case says, so a re-keyed cell red for its pinned reason that also failed a NEW check would have passed. Each re-key now lists the check ids the cell fails today (from the post-W2a drive, not from the repro runs above, which predate W2a and fail SC-O1's own `I4-nothing-ends-stuck` and `life-loop-bounded`): `[]` for the five R4 cells (a case-level error, no check) and `I4-nothing-ends-stuck`, `life-loop-bounded`, `advance-seeded-as-declared` for ko_plate F1. A failing check outside the list makes the judge report a wrong reason; a pinned check that no longer fails is progress and passes.
