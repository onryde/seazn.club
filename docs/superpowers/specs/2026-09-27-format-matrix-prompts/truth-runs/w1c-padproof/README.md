# W1c pad proof — 11 sports × 1280 / 320, three runs each, plus a 1280 rerun

`pnpm matrix:browser --set pad-proof --width W --run-id w1c-pp-W-rN` (harness `b7668c0ff`, local
standalone production build, served hold 3000 ms, base `[local-base]`). Each case builds a league of
the sport, starts it, and scores THREE fixtures on the ScoringPad through the pad's own controls
(generated per the sport's adapter), finalizes them, and then folds the pad's ledger rows back against
the events the generator produced (`pad-ledger-as-generated`). Task 11's run is the baseline
(66/66 works; fallbacks football goals 2, cricket innings 6, icehockey advances 9, hockey advances 12).

## The runs

There were seven runs at harness `b7668c0ff` (clean tree), each exit 0: three at 1280, three at 320, and `w1c-pp-1280-r4`, a fresh-id
rerun at 1280. Every ledger passes in every clean run, and each sport's split (rows = equal / tolerated / fallback) is identical in
every clean run: football 11 = 9/0/2, cricket 9 = 3/0/6, icehockey 15 = 6/0/9, hockey 17 = 5/0/12, and every other sport all-equal
(boardgame 6, carrom 27, generic 6, volleyball 9, badminton 9, tabletennis 12, tennis 9). Finalize passes 3/3 for every sport.

| pad proof sport | 1280 r1 | 1280 r2 | 1280 r3 | 1280 r4 (rerun) | 320 r1 | 320 r2 | 320 r3 |
|---|---|---|---|---|---|---|---|
| football | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| cricket | ✅ works | ✅ works | ❌ red | ✅ works | ✅ works | ✅ works | ✅ works |
| boardgame | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| carrom | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| generic | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| volleyball | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| badminton | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| tabletennis | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| tennis | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| icehockey | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| hockey | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |

**1280 r3, cricket ❌: environmental, not a product or harness defect.**

- **What failed.** One tap failed in fixture 1's second innings: tap 15 of 141, a tile, threw `TimeoutError: locator.waitFor: Timeout
  15000ms exceeded`. That is the harness's derived floor, `FLOOR_MS` (`lib/browser/budget.ts:16`).
- **What followed from it.** The fixture was left in play. That one event reads missing (ledger 10 = 4/0/5 + 1 missing). The fixture then
  fails `pad-finalized`, `pad-outcome-as-requested`, `life-fold-parity`, `life-loop-bounded` and I4.
- **The same case recovered.** Fixtures 2 and 3 scored and finalized cleanly.
- **What the screen shows.** `08-pad-scored`, taken after the timeout, reads 180/4 (20) against 14/0 (2), and its "End of over 3" tile
  is rendered and enabled. The awaited tile came, but late.
- **The load.** The machine's load average rose from about 18 at the run's start to 232 (1 min) / 199 (5 min) at 13:52Z, during the
  failing case. The load came from processes outside this run. The same case took 405 s here, against 288 s and 295 s in r1 and r2.
- **The rerun.** `w1c-pp-1280-r4` then ran at a falling load (71, down to 9), and cricket passed with the same 9 = 3/0/6 split as every
  other run.
- **No change made.** The harness budget is derived and text-pinned. A 15 s floor is five times a 3 s hold at normal load, so widening it on
  this evidence would weaken the gate. The note goes to W1d: if CI shows a tap-wait timeout, measure the runner's load first.


## Per-screen verdicts — run 1, three screens per sport × both widths

The three screens are the first fixture's `08-pad-before` (the pad as the scorer finds it),
`08-pad-scored` (after the generated taps, before Finalize) and `09-finalized` (the last state the
case proves). "ok" = the screen shows the state its step claims, and the score on it is the one the
generator drove.

### 1280 (`w1c-pp-1280-r1`)

| sport | 08-pad-before | 08-pad-scored | 09-finalized |
|---|---|---|---|
| football 11-a-side | ok — Scheduled, board 0–0 "Period before kick-off", lineup cards "Starting line-up still needs: Goalkeeper ×1" | ok — Decided 1–0, Activity 4 (started, goal, half-time, full-time), Ledger Verified | ok — Finalized 1–0, Activity 5 |
| cricket t20 | ok — board 0/0 · 0.0, Toss | ok — Decided "180/4 (20) – 150/5 (20)", Player 1 won, target 181 shown, Activity 41 overs | ok — Finalized, Activity 42 |
| boardgame blitz | ok — colours tracker, Pairing card | ok — Decided 1–0, "Result recorded — Home · Checkmate" | ok — Finalized, Activity 3 |
| carrom club-29 | ok — Best of 3 · first to 29, 0 (0) – 0 (0), Toss | ok — Decided 2–0, eight "Board recorded — Home · 9 coins left" (4 boards × 9 ≥ 29 per game) | ok — Finalized, Activity 10 |
| generic score | ok — running score board, Enter final score | ok — Decided 3–1, "Result recorded — 3 – 1" | ok — Finalized, Activity 3 |
| volleyball beach | ok — Best of 3 · Set 1, 0–0 | ok — Decided "2 – 0 · 21-16, 21-16" | ok — Finalized, Activity 4 |
| badminton bwf | ok — Best of 3 · Game 1, 0–0 | ok — Decided "2 – 0 · 21-16, 21-16" on one line | ok — Finalized, Activity 4 |
| tabletennis bo5 | ok — Best of 5 · Game 1 | ok — Decided "3 – 0 · 11-6, 11-6, 11-6" | ok — Finalized, Activity 5 |
| tennis tour | ok — Best of 3 · Set 1, "Serving Home" | ok — Decided "2 – 0 · 6-3 6-3", recorded by the chair umpire | ok — Finalized, Activity 4 |
| icehockey iihf | ok — 3 × 20 min, "Period not started", Goaltender needed ×1 | ok — Decided 1–0; Activity "Goal" carries a **PARTIAL** chip (N-3, soft) | ok — Finalized, Activity 6 |
| hockey fih-outdoor | ok — 4 × 15 min, "Period not started" | ok — Decided 1–0; "Goal PARTIAL" (N-3); Period ended Q2 / Q3 / Q4 / Full-time | ok — Finalized, Activity 7 |

N-3 (soft, new): a goal recorded without a scorer reads "Goal · PARTIAL" in hockey and ice hockey,
while football's equally scorerless goal reads "Goal recorded" with no chip — the same fact is told
two ways. Whether an organiser is meant to see "PARTIAL" is an owner question, not a defect claim.

### 320 (`w1c-pp-320-r1`)

At 320 the lineup cards fold to "Lineup ▾" and the Activity card shows its newest row only, so the scorer
chips of N-3 are not on these three screens.

| sport | 08-pad-before | 08-pad-scored | 09-finalized |
|---|---|---|---|
| football 11-a-side | ok — Scheduled, 0–0 "Period before kick-off", Start match, Forfeit… / Abandon… | ok — Decided 1–0, Activity 4 (newest "Period marker recorded — Full-time"), Ledger Verified | ok — Finalized 1–0, Activity 5 "Match finalized" |
| cricket t20 | ok — T20 · over 0.0, 0/0, Toss | ok — Decided "180/4 (20) – 150/5" / "(20)": the second innings' overs wrap to a new line (recorded by Task 11: wraps, does not clip); scorebug 150/5 · 20.0 · Target 181; Activity 41 | ok — Finalized, same two-line headline, Activity 42 |
| boardgame blitz | ok — colours tracker, Pairing card | ok — Decided 1–0, "Result recorded — Home · Checkmate" | ok — Finalized, Activity 3 |
| carrom club-29 | ok — Best of 3 · first to 29, 0 (0) – 0 (0), Toss | ok — Decided 2–0, Activity 9 (newest "Board recorded — Home · 9 coins left") | ok — Finalized, Activity 10 |
| generic score | ok — running score, draws allowed, Enter final score | ok — Decided 3–1, "Result recorded — 3 – 1" | ok — Finalized, Activity 3 |
| volleyball beach | ok — Best of 3 · Set 1, Sets 0–0 | ok for the state; the headline wraps mid-score "2 – 0 · 21-16, 21-" / "16" (**PF-1**, known) | ok for the state; PF-1 again on the Finalized headline |
| badminton bwf | ok — Best of 3 · Game 1, Games 0–0 | ok for the state; **PF-1** "21-" / "16" | ok for the state; PF-1 again |
| tabletennis bo5 | ok — Best of 5 · Game 1 | ok — "3 – 0 · 11-6, 11-6," / "11-6" wraps BETWEEN games at the comma (not PF-1, as Task 9 recorded) | ok — the same wrap, Activity 5 |
| tennis tour | ok — Best of 3 · Set 1, Sets 0–0 · Games 0–0 · Serving Home | ok — headline "2 – 0 · 6-3 6-3" on one line; the Activity row reads "Set score recorded — 6–" / "3", the PF-1 wrap class inside an activity row | ok — Finalized, Activity 4 |
| icehockey iihf | ok — "3 × 20 min · overtime · GWS", "Period not started" | ok — Decided 1–0, Activity 5 (newest "Period ended — Full-time") | ok — Finalized, Activity 6 |
| hockey fih-outdoor | ok — "4 × 15 min", "Period not started" | ok — Decided 1–0, Activity 6 | ok — Finalized, Activity 7 |

**Run 1 totals:** 66 verdicts (11 sports × 3 screens × 2 widths), every one ok for the state its step claims.
Defects on screen: PF-1 on volleyball and badminton at 320 (known), and the same mid-score wrap in tennis's
Activity row at 320 (the PF-1 class, newly seen in that place). Soft: N-3. Activity counts agree across the two
widths for every sport.

## Runs 2 to 4 (screens)

Every run wrote 381 shots, except 1280 r3, which wrote 379: its red cricket fixture never reached Finalize. Between 326 and 333 of
each run's shots are distinct. The spread comes from timestamps and sync state, which differ from run to run. Each run had the same
steps as run 1, so run 1's verdicts stand for runs 2 to 4, and those shots were not read one by one again. The one screen that was
re-read is 1280 r3's cricket `08-pad-scored`, described above.
