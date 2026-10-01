# W1-driving L3: the ruling-48 run, 937 cases on 4 workers

Layer L3, driver http, plan `--set w1-driving` (ruling 48: every catalogue row on every sport, LIFECYCLE / M1 / R4 / F1 where applicable, plus cricket's `test` cases). W1-driving Task 15.

**The env.** One fresh `seazn-local-env` stand-up, label `w1drvt15`:

- Postgres at v428 (main's V427/V428 included, T15-R2), built with `db:apply` + `sync:sports`. `show data_directory` equals `BENCH_EXPECTED_DATA_DIR`.
- The standalone production build came from this tree with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`.
- `SMOKE_BASE` was the env's own app port (`[local-base]`). No `REDIS_URL`. The PostHog and Sentry keys were blanked, and 0 static chunks carry either.

**The run.** `pnpm matrix:l3 --set w1-driving --workers 4 --run-id w1drv-l3`. Harness `15ed62365`, clean. EXIT 0 in 16 min 28 s.

## Histogram

| state | cases |
|---|---|
| ✅ works | 743 |
| ❌ red | 194 |
| ⏳ later | 0 |
| 🚫 no_path | 0 |
| ░ not_run | 0 |
| ⛔ refused | 0 |
| ⬜ needs_ruling | 0 |
| **total** | **937**, the planner's own count (`planW1Driving(offlineBuilderDefault)`; LIFECYCLE 255, M1 231, R4 231, F1 220) |

- 11 of the reds are error reds. All are `stepladder_only|*|R4`, where the withdraw answers `422 WRONG_PHASE`.
- 0 reds are vacuous.
- `later` with wave `W1-driving`: **0**. That is done-when 1.

`MATRIX.md` is the renderer's own view: `pnpm matrix:render` printed "937 cases", and the file is byte-identical to the one the run wrote, with one row per case.

## Workers (ruling 48)

Before this run, five new-capability cells were each run on 1 worker and on 4: team roster (`league|football`), multi-stage (`groups_ko|badminton`), ladder (`ladder|generic`), americano (`americano|badminton`) and cricket test (`league|cricket`).

- Across 23 cases and 468 checks per side, **0 cases differ** in state, reason, counts, or any check's verdict or `checked` count.
- The HTTP slice on 4 workers (`../w1drv-http-slice`) equals W1c's 1-worker slice in all 24 states and all 378 shared checks.

## Triage: [`TRIAGE.md`](TRIAGE.md)

Every ❌ is on one line there. The classes are exclusive:

- **harness: 60.** Three defects, each fixed test-first in its own commit:
  - `9a64ec4cd`: the F1 bracket opening size;
  - `b1325f721`: M1 on a stepladder;
  - `e51bf3699`: the mexicano duplicate signature.

  Their cells were re-run under [`../w1drv-l3-rerun`](../w1drv-l3-rerun): every case of `stepladder_only`, `double_elim` and `mexicano` on 11 sports, 33 runs. **30 of these cases now work.** The other 30 are still red for a product reason and are re-triaged in TRIAGE.md.
- **product: 134.** With the 30 above, **164 product reds** remain, each judged on its latest committed run (T15 fix round 1 added [`../w1drv-l3-fr1`](../w1drv-l3-fr1): americano/mexicano R4 at the derived policy, the 17 P1 cells, and the P1 draw counts read from that env's DB):
  - **W4: 94.** The bracket-draw stall (62), the ko_plate seeding 409 (10), the page-playoff R4 dead final (11) and the stepladder withdraw refusal (11).
  - **W7: 56.** The coverage table (44) and mexicano consequences outside it (12).
  - **W5: 11.** group_group_ko F1, seed 1 alone in a pool.
  - **W3: 3.** Swiss R4 round 5 pairs nobody (SW-H1); the fourth case (swiss_playoff boardgame) reached a page-playoff draw stall on its fr1 run instead.
- **unfit: 0.** One owner recommendation is recorded, not assumed: group_group_ko F1.

**Routing conflict for the controller.** The bracket-draw stall is routed **W4**, per ruling T6-R1. Design §8 puts SC-O1/SC-O2, the `supportsDraws` root cause, under **W2**.

## Predicted product reds, by name

The full table is in TRIAGE.md. Its verdicts:

| prediction | verdict |
|---|---|
| ko_plate F1 | **confirmed 10/11**. The boardgame case is masked by a draw stall. |
| group_group_ko F1 | **confirmed 11/11** |
| team-sport americano/mexicano note | **confirmed on all 42 cases of the 10 cells** |
| mexicano M1 stall | **confirmed 11/11**, with full set `[life-loop-bounded]` |
| self-pair 500 | **confirmed on 30 cases** |
| round-2 duplicate | **confirmed on 29 cases** |
| R4 kept-playing | **confirmed** on americano 11/11, covering the derived policy red. On mexicano it is 4/11 where the second leg is seen, and note-only there: the derived policy passes. |
| page_playoff_only R4 | **confirmed 11/11** |
| ladder R4 | **confirmed**: no red, and a W7 note on each of the 11 cases |
| double-elim `gf-reset` | **not confirmed (0)**. No row sets `bracketReset`. |
| T2 generic page-playoff draw | **confirmed (10)** |

## Findings this run adds, in the product's own words

- **W7, Americano view.** `GET /api/v1/stages/{id}/americano`, read live as the owner on 22 stages, shows "Personal points" as 0 on every sport but generic. On the other 10 sports, 0 of the 14 decided fixtures carry a `match_states` score.
- **W7, mexicano completes early.** A mexicano stage completes after any decided round. In the DB, every sampled mexicano stage is `complete` at round 1 or 2 of 7.
- **Reproducibility.** Five mexicano R4 cases changed failing set between this run and the re-run. Whether the self-pair 500 fires at round 2, at round 3 or not at all varies. See TRIAGE.md.
- **Not observable live.** "mexicano sit-outs never rotate (3 of 7)" cannot be seen, because every mexicano F1 case is stopped by the self-pair 500 by round 3. This stays owed.

## Flakes and timing

- No L3 red is timing-shaped. 0 checks time out, 0 touch the pad ledger, and 0 texts carry the `model:` prefix. So no case was owed the triple run.
- One reproducibility finding is above: five mexicano R4 cases moved between runs.

## The model on the same env (`../w1drv-model`, T14 Step 7)

Harness `e26eda889`, clean. A cell counts as ok only when it is not vacuous and no command ran zero times.

| run | cells | verdict |
|---|---|---|
| `w1drv-model-sb` | swiss\|badminton ×40 | ok 40/40. I6 492, I8 845, fold parity 201. |
| `w1drv-model-sg` | swiss\|generic ×40 | ok 40/40. I6 312, I8 491, fold parity 176. |
| `w1drv-model-fb` | league\|football ×20 | ok 20/20. Lineups 432, I7 1275. |
| `w1drv-model-reg` | `--regressions` | 5/5 known, MB-001 to MB-005, each reproduced exactly |
| `w1drv-model-m6` | the six m-6 rows on generic ×20 | Exit 1, which is correct for two NEW product failures. Four rows are ok 20/20: `triple_rr`, `group_only`, `knockout_third_place` and `page_playoff_only`. |

The two NEW failures:

- **`double_elim`.** Generate → AddEntrant → Generate answers `500 INTERNAL`: "bye-award bulk UPDATE would strand home_slot_label". This is MB-005's defect, on a double elimination.
- **`stepladder_only`.** Start → Withdraw answers `422 WRONG_PHASE`: "fixture has an unassigned entrant (bye/TBD)". This is the same as the L3 stepladder R4 finding.

Neither has been added to `regressions.json`; that catalogue entry is the controller's call. After its failure, `double_elim` ran no Withdraw, Score, Walkover, Void, Correct, Rebuild or Complete commands, so that coverage is still owed.
