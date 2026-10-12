# W2b final truth run: the local half (Task 16 Steps 1–3)

Task 16 of W2b (plan `docs/superpowers/plans/2026-10-09-format-matrix-w2b.md`; spec
`docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §8.3–5) drives the W2b cells locally: the five
boardgame R4 cells W2a re-keyed to CD-T13, and the five W2b scenarios. The CI half (the full matrix and the regression
judge, Steps 4–7) has not run yet, so there is no `ci/` and no top-level `MATRIX.md` here.

**Verdict: the R4 half passes; the new-scenario half is NEGATIVE.** All 5 R4 cells are `works`. Every W2b-owned
check passes, with `checked > 0` wherever it applies. But 23 of the 246 scenario cases are red, for three causes
(below), and none of them is a forfeit-after-Start case (rulings 112–114).

**After rulings R16 (see "Rulings R16: the re-run", below):**
- AB-AWARD is 4/4 `works`.
- DW-ALL is 110/110 `works`.
- WD-CASC, after ruling R16-5 (`local/L3/w2b-final-r165-wd-casc`): 6 cells `works` (the crowned half), 5 red (the
  vacant half). The 5 red cells are all W4's (vacant title; MB-004/005, ruling R16-2), so W2b has no red left.
- WD-CASC, after owner ruling 116 (`local/L3/w2b-final-r116-wd-casc`): the same 6 `works` and the same 5 W4 reds,
  cell for cell. The X-WD-3 tie now reads `w/o` and names the withdrawn winner on every public surface (below).

## The run

| | |
|---|---|
| branch | `feat/format-matrix-w2b` at `7c95a49f1` (results `harnessCommit` `7c95a49f1`, tree clean during the run) |
| database | a fresh Postgres from `seazn-env up --label w2b --placement` (Flyway to v435, then `sync:sports`); `show data_directory` printed `/tmp/seazn-env/w2b/pg`, the label's own datadir, exported as `BENCH_EXPECTED_DATA_DIR` |
| server | `seazn-env rebuild --label w2b`: a fresh production standalone build of this worktree (turbo cache miss), `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` baked and exported, PostHog and Sentry blank |
| placement | the label's own native service |
| selection | `../w2b-local-selection.json`: `cases` 5, `newScenarios` 5 (WO-PRE, RT-PART, DW-ALL, AB-AWARD, WD-CASC); both `browserShards` arrays empty, so the run is L3 only |
| command | the plan's Global Constraints truth-run command (W2a plan, w2a → w2b), `<tag>` = `final`; every line printed `EXIT=0` |
| time | 2026-10-12 06:25:36 – 06:28:52 UTC |

## Result

| run | cases | works | red | W2b checks (pass / abstain / fail) |
|---|---|---|---|---|
| `local/L3/w2b-final-1` … `-5` (R4) | 5 | **5** | 0 | — (11–12 checks each, 0 fail) |
| `local/L3/w2b-final-new-wo-pre` | 99 | 99 | 0 | 198 / 99 / 0 |
| `local/L3/w2b-final-new-rt-part` | 22 | 22 | 0 | 66 / 22 / 0 |
| `local/L3/w2b-final-new-dw-all` | 110 | 99 | **11** | 319 / 231 / 0 |
| `local/L3/w2b-final-new-ab-award` | 4 | 3 | **1** | 6 / 3 / 0 (the red cell ran no check) |
| `local/L3/w2b-final-new-wd-casc` | 11 | 0 | **11** | 49 / 0 / 0 |

"W2b checks" are the scenario-owned `w2b-*` checks plus `life-reference-bracket-finish`. No pass has `checked = 0`, and
every runner summary reads `vacuous: none`.

## The 23 red scenario cases, by cause

1. **`I2-bracket-one-champion-ranks-permutation` does not know a double walkover (22 cells: DW-ALL ×11, WD-CASC ×11,
   every `knockout|<sport>` cell).** `tools/matrix/lib/invariants.ts:164-168` (last changed by `b9497f9bf`, before
   W2b) has two problems with a double walkover:
   - It fails any terminal bracket fixture whose outcome has no winner (`<id>: bracket fixture ended double_walkover`).
   - It never adds the two DW sides to `lost`, so they count as unbeaten (`3 unbeaten entrants`, or 5 in WD-CASC).

   In the same cells the W2b checks that judge the double walkover itself all pass: recorded, advances nobody,
   final refused, table, and `life-reference-bracket-finish`. The repro2 run (`../w2b-repro/new`) could not show
   this, because the unfixed product refused every double walkover.
   **Class:** a harness gap. The generic invariant predates `double_walkover` (X-DW-1). It is not a product defect.
   **Correction (R16 re-run):** the WD-CASC half of this is wrong.
   - Its "5 unbeaten" were the two double-walkover sides, the champion, and two entrants who won a match and then
     withdrew.
   - With the double walkover fixed, 3 remain (see below).
2. **WD-CASC's vacant-final half: Generate answers 500 (5 cells: cricket, carrom, volleyball, table tennis, ice
   hockey; the odd-indexed cells, `wdCascFinalHalf`).**
   - After the final is voided beside a voided feeder (title vacant, W4), the round loop calls Generate.
   - The server throws `generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label on fixture(s) … —
     this path is not supposed to be reachable with a label present` (5 `level:50` lines in the label's
     `server.log`).
   - Failing checks: `I4-nothing-ends-stuck`, `I8-generate-named`, `life-loop-bounded` (`refused_generate`).
   - `w2b-withdrawal-final-vacant` passes in all 5 (checked 2 each).

   **Class:** the known product assertion MB-004/MB-005 (`_INDEX.md`, routed W4 + W9), now reached by a new path: a
   void final.
3. **AB-AWARD `league|icehockey|iihf`: the level abandon is refused (1 cell).**
   - The leading abandon was accepted.
   - The level abandon, `core.abandon` at 1–1 on fixture `2db7dcf1…`, still `in_play` with START, 2 goals and no
     abandon stored, was refused `422 DRAW_NOT_ALLOWED: this stage cannot end level — decide it by extra time or a
     shootout`.
   - The case errored before any check ran.

   Why:
   - IH-AB-1 ("Same as FB-AB-1": a level award-policy abandon is a draw with the real score in draw kinds) folds
     the abandon to `{kind:"draw"}`.
   - `apps/web/src/server/engine-db/append-event.ts:516` refuses a draw wherever `supportsDraws` is false.
   - The `iihf` cfg (schema defaults) configures overtime and a shootout, so `supportsDraws(league)` is false
     (`packages/engine/src/sports/period/kernel.ts:2730`).
   - Football and FIH-outdoor hockey (no decider configured) work.
   - `award-abandon-status.test.ts` folds through `foldFrom` and `fixtureStatusFromFold` only, so no unit test
     reaches the append gate.

   **Class:** a conflict between rule IH-AB-1 and the no-draw gate, for an owner ruling. The organiser cannot record
   a level abandon of an IIHF league match at all.

## Step 2: the five rekeys (`w2a-expect-before.json`)

`tools/matrix/w2a-expect.ts`:
- `--expect ../w2a-repro/expect-77.json --rekeys ../w2a-repro/expect-77-rekeys.json`;
- `--now` the five local R4 runs (`local/L3/w2b-final-1` … `-5`; the plan's `local/L3/results.json` does not exist,
  because each run writes its own directory);
- then W2a's committed CI L3, L2 and L1.

Exit **1**:

    expected 77, found 77: 69 works, 2 red as pinned, 5 greened; 1 unexpected red, 0 wrong reason (2902 case(s) read)

- `greened` lists exactly the five boardgame R4 ids.
- The two non-W2b pins hold (`ko_plate|boardgame|blitz|F1` → W4, `swiss_playoff|generic|score|R4` → W3).
- The one unexpected red is `page_playoff_only|generic|score|M1`, read from W2a's own CI L3. That is W2a false
  premise 50, a harness defect W2a routed to the controller, unfixed on this branch. So the plan's "EXIT=0" cannot
  hold from these inputs.

Controller ruling R16-4 accepted that exit: its only cause is the M1 cell, W2a false premise 50. The five W2b
entries are now removed from `../w2a-repro/expect-77-rekeys.json`, and its `note` says they were removed by W2b Task 16
and judged greened here. The same judge, re-run on the same eight inputs (`w2a-expect-after.json`), gives exit 1:

    expected 77, found 77: 74 works, 2 red as pinned, 0 greened; 1 unexpected red, 0 wrong reason (2902 case(s) read)

- before: `greened` = exactly the five boardgame R4 ids; after: `greened` = `[]`.
- The one known failing cell, before and after, is `page_playoff_only|generic|score|M1`.

## Step 3: the probes, ungated

The `W2B_REPRO` gate is removed from `packages/engine/src/core/w2b-repro.probe.test.ts` and
`apps/web/src/server/__tests__/w2b-repro.probe.test.ts`; the web file keeps its database condition.

| file | env | total | passed | failed | pending |
|---|---|---|---|---|---|
| engine probes | none | 10 | 10 | 0 | 0 |
| web probes | the label's `DATABASE_URL`, no `W2B_REPRO` | 12 | 12 | 0 | 0 |
| web probes | `DATABASE_URL=` (empty) | 12 | 0 | 0 | 12 |

## Rulings R16: the re-run (`local/L3/w2b-final-r16b-*`)

The controller's rulings on the three causes:
- **R16-1:** I2 is a W2b harness defect.
- **R16-2:** WD-CASC's vacant-final half is W4's (MB-004/005).
- **R16-3:** the IIHF refusal is a W2b product defect. In a kind where draws are off, a level award-policy abandon is
  accepted with no result.

The fixes on this branch:

| commit | ruling | change |
|---|---|---|
| `605be790d` | R16-1 | I2 counts a stored `double_walkover` as beating both sides, and no longer flags it |
| `3203d2140` | R16-3 | the period kernel: a level award-policy abandon has no result where the cfg refuses a draw (`drawStands`, shared with `supportsDraws`); the gate needs no exemption, because no draw reaches it |
| `0bae87f10` | R16-3 | AB-AWARD: the level abandon expects abandoned with no outcome, and out of the table, where `supportsDraws` is false; every abandon delta judges `played` |
| `410a3e20b` | R16-3 | `life-results-as-posted` accepts an abandon whose fold leaves no result: stored `abandoned`, no outcome |

The three scenarios were re-run whole, on a fresh env:
- `seazn-env up --label w2b --placement`, then `rebuild` at `0bae87f10`, with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`
  baked in (`}("3000")` is in the static chunks).
- The harness ran at `410a3e20b`, a clean tree.
- 2026-10-12, 07:23:58 – 07:26:45 UTC; every run printed `EXIT=0`.
- New run ids, `w2b-final-r16b-*`. The `w2b-final-new-*` runs above stay as the record of the reds before the fix.

| run | cases | works | red |
|---|---|---|---|
| `local/L3/w2b-final-r16b-ab-award` | 4 | **4** | 0 |
| `local/L3/w2b-final-r16b-dw-all` | 110 | **110** | 0 |
| `local/L3/w2b-final-r16b-wd-casc` | 11 | 0 | **11** |

**AB-AWARD `league|icehockey|iihf` now works.**
- The level abandon is accepted and stored `abandoned` with no outcome.
- Both sides are out of the table.
- The first re-run (`0bae87f10`, not committed) still reds here on `life-results-as-posted`: "stored abandoned null
  over a stream the harness cannot fold". That check had no case for an abandon its fold leaves without a result.
  `410a3e20b` closes it.

**WD-CASC, by cell:**
- **W4-owned, MB-004/005 (ruling R16-2): cricket, carrom, volleyball, table tennis, ice hockey.**
  - In these 5 cells Generate still answers 500 ("bye-award bulk UPDATE would strand home_slot_label") after the
    void final.
  - They are not counted as W2b reds. They are neither weakened nor skipped.
- **All 11 cells: `I2-bracket-one-champion-ranks-permutation: 3 unbeaten entrants`.** This is not a double
  walkover. Read from the env's database, `knockout|hockey|fih-outdoor`:
  - QF1: seed 1 wins, then withdraws. Its semi-final is stored with that seat emptied and a bye `award` to the other
    side, with `loser: null`.
  - QF3: seed 6 takes the walkover from seed 3, then withdraws. Its semi-final, whose other feeder is QF4's double
    walkover, is stored `abandoned` with both seats empty.
  - So no stored fixture records either withdrawn winner losing, and I2 reads both as unbeaten, beside the champion.
  - The W2b checks that judge this cascade pass in every cell.
  - Ruled in R16-5, below.

## Ruling R16-5: I2 and a departed entrant (`local/L3/w2b-final-r165-wd-casc`)

The ruling is option (a), and the change is commit `ea97cc3fd`:
- I2 counts an entrant the product STORES as departed as eliminated. "Departed" is a status in `DEPARTED_STATUSES`.
- `snapshot` reads it from `listEntrants`, never from the scenario.
- A withdrawn case whose run carries no departures fails by name.
- An unbeaten entrant who never withdrew still fails I2.

The re-run:
- A fresh env: `up --label w2b --placement`, then `rebuild` at `ea97cc3fd`. `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` is
  baked in, and `show data_directory` printed `/tmp/seazn-env/w2b/pg`.
- Harness `ea97cc3fd`, clean tree, 2026-10-12 07:43:23 – 07:43:34 UTC, `EXIT=0`.

| cells | state | I2 | other fails |
|---|---|---|---|
| football, boardgame, generic, badminton, tennis, hockey (crowned half) | **works** | pass, checked 9: "2 departed entrant(s) counted eliminated" (QF1's winner and QF3's walkover winner) | none |
| cricket, carrom, volleyball, table tennis, ice hockey (vacant half) | red | fail: "0 unbeaten entrants" — the finalist withdrew too, so the title is vacant (W4) | I4, I8, `life-loop-bounded`: Generate 500 (MB-004/005, W4) |

All 38 W2b checks in the run pass.

### The X-WD-3 tie, as the public site shows it (hockey cell, `m-w2b-final-r165-wd-casc-11`, read in a browser at 1280)

The tie is SF1, `se-r1-i0`:
- QF1's winner (Matrix Team 1) withdrew while this semi-final's other seat was TBD.
- The tie is stored `forfeited`, `{kind:"award", winner: Team 4, reason:"bye"}`.
  - It has no `loser` and no `method`.
  - It has no score event.
  - Its home slot label is `bracket.slot.bye`.

| surface | text on the tie |
|---|---|
| schedule tab (Semi-finals) | `Ended` · `Bye` · `Matrix Team 4` |
| bracket (Standings tab) | `Bye` · `Matrix Team 4` · `TBD` |
| match page | title `Bye vs Matrix Team 4 — Matrix hockey (Forfeited)`; body `BYE — MATRIX TEAM 4 — Forfeited`, then "This match was recorded as a result only, with no play-by-play detail." |

- No surface says "w/o" or "walkover" on this tie, or names the withdrawn entrant.
- QF2 and QF3, the walkovers the withdrawals wrote, show the `w/o` tag, with the sentence "Matrix Team 5 withdrew —
  walkover."
- The final reads `Matrix Team 4` · `Bye` (`Ended` on the schedule, `TBD` on the bracket). The banner reads
  `Champion` / `Matrix Team 4`.
- **Question for the owner:** X-WD-3 says the arriving opponent "advances by walkover". The product
  stores it, and every surface shows it, as a bye. Separately, the bracket prints `TBD` on two finished bye tiles
  (SF1 and the final). **Ruled: owner ruling 116 — see "Ruling 116", below.** The `TBD` on a bye tile stays W4's.

### "Abandoned with both seats empty"

This is SF2, `se-r1-i1`, line b's semi-final in every WD-CASC cell (hockey fixture `448003af`).
- Nothing was posted to SF2 itself: it has no score events. The product's seat resolver wrote it after two steps:
  - QF3's home side withdrew before the start, so QF3 was walked over to Matrix Team 6. That winner then withdrew
    while SF2's other seat was TBD, so that seat is departed (slot label `bracket.slot.bye`).
  - QF4 was a recorded double walkover (`core.forfeit{reason:"walkover", by:"both"}`), so SF2's other seat is dead
    but not departed (slot label "winner of R1 match 4").
- The resolver (`stages.ts`, "OWNER RULING 2026-09-21 (re-review C2): a walkover REQUIRES A LIVE RECIPIENT") voids a
  line with no live recipient. So SF2 is stored `abandoned`, with no outcome and nobody seated.
- **It is neither X-WD-4 nor W4's family:**
  - X-WD-4 needs BOTH sides withdrawn, which gives a double walkover. The matrix cannot drive that here; it is
    unit-tested on the fake.
  - MB-004/005 is the vacant half's Generate 500.
  - This is the C2 void, which WD-CASC's own `w2b-withdrawal-both-seats-dead` check pins, and it passes.
- **Display, for the owner (not changed):** the public schedule and bracket show SF2 as `TBD` · `Bye` · `Winner of
  Quarter-finals, match 4`. That is a void match labelled TBD, naming a winner QF4's double walkover can never
  produce.

## Ruling 116: the withdrawn winner's next tie (`local/L3/w2b-final-r116-wd-casc`)

Owner ruling 116 (`_INDEX.md`): when a knockout winner withdraws while her next tie's opponent is TBD, the arriving
side walks over HER. The tie reads `w/o` and names the withdrawn side on the schedule, the bracket and the match page.
Her seat stays dead, and she is never seated. The change is commit `4d09b7bf3`:
- `awardSeededByes` (`stages.ts`) stores the walkover itself: `{kind:"award", winner, loser: <her>, reason:"withdrew"}`.
  It names her only when the dead seat's own WINNER edge delivers an entrant now `withdrawn`.
- A genuine bye, a void's or a double walkover's dead seat, a disqualified winner, a generation-time departure (F14)
  and a loser-edge seat (X-WD-5) all stay a bye, byte for byte.
- `bracketWinnerLoser` reads an award whose loser holds no seat as no loss, so the ranks do not move.

The re-run:
- Server rebuilt at `4d09b7bf3` (`NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` baked in; the bundle carries the new SQL).
- Harness `4d09b7bf3`, clean tree, 2026-10-12 11:22:15 – 11:22:25 UTC, `EXIT=0`. The plan is byte-identical to r165's
  (lock-append-only: 282 compared, 1 added).
- The same 6 cells `works` and the same 5 W4 reds (Generate 500, MB-004/005) as r165, cell for cell. I2 passes,
  checked 9, in the crowned half.
- `w2b-withdrawal-tbd-seat` now demands loser w1, reason withdrew, on SF1. It passes in all 11 cells (checked 4 in
  the crowned half, 5 in the vacant half). Every W2b check passes in every cell.

Stored, in the hockey cell (`m-w2b-final-r116-wd-casc-11`):
- SF1 (`se-r1-i0`) is `forfeited`, `{kind:"award", winner: Team 4, loser: Team 1, reason:"withdrew"}`. Its home seat
  is empty (slot label `bracket.slot.bye`), it has no score event, and Team 1 is `withdrawn`.
- The final (`se-r2-i0`) stays `{kind:"award", winner: Team 4, loser: null, reason:"bye"}`. SF2's void delivers no
  winner, so nobody withdrew from that seat: the positive pair, live.

Read in a browser at 1280, 768 and 320 (no horizontal page scroll at any width; at 320 the bracket chip sits inside
the bracket's own scroll rail):

| surface | before (r165) | after (r116) |
|---|---|---|
| schedule tab, SF1 | `Ended` · `Bye` · `Matrix Team 4` | `Ended` · `Bye` · `w/o` · `Matrix Team 4`; the chip's title and aria-label read "Matrix Team 1 withdrew — walkover." |
| bracket (Standings tab), SF1 | `Bye` · `Matrix Team 4` · `TBD` | `Bye` · `Matrix Team 4` · `w/o` (same sentence) |
| match page, SF1 | title `Bye vs Matrix Team 4 — Matrix hockey (Forfeited)`; body `BYE — MATRIX TEAM 4 — Forfeited` | title `Bye vs Matrix Team 4 — Matrix hockey (Matrix Team 1 withdrew — walkover.)`; body `BYE — M4 MATRIX TEAM 4 — Matrix Team 1 withdrew — walkover.` |
| final | `Ended` · `Matrix Team 4` · `Bye` (bracket footer `TBD`) | unchanged: a genuine bye, no chip |

- The champion banner still reads `Champion` / `Matrix Team 4`.
- Unchanged and out of scope (W4's): the empty seat's own word still reads `Bye`, the final's bye tile still prints
  `TBD`, and SF2's void still reads `TBD` · `Bye` · `Winner of Quarter-finals, match 4`.
