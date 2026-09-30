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

**Flake finding F-PP-1 (UNEXPLAINED): 1280 r3, cricket ❌ on `pad-ledger-as-generated`.** The cause is not established. → **W1d**.

- **What failed.**
  - The fixture is `dabf515d-99da-4a03-8e52-c3e052c611e3` (fixture 1 of the case).
  - The event is event 3 of 3, its second `cricket.innings.summary`.
  - Tap 15 of 141 (a tile) threw `TimeoutError: locator.waitFor: Timeout 15000ms exceeded`.
  - 15 s is the harness's derived floor, `FLOOR_MS` (`lib/browser/budget.ts:16`).
  - All of this is quoted from the committed `w1c-pp-1280-r3/results.json`, check `pad-ledger-as-generated`.
- **What followed from it.** The ledger check read 3 equal, 0 tolerated, 5 fallback and 1 missing rows, plus one "stopped after event 3
  of 3" finding. That makes 10 evidence items, not 10 rows. The fixture stayed in play, so the same fixture also fails `pad-finalized`,
  `pad-outcome-as-requested`, `life-fold-parity`, `life-loop-bounded` and I4.
- **The rest of the case.** Fixtures 2 and 3 scored cleanly, each with the fallback on both innings. Only two fixtures reached
  Finalize, so this run holds 379 shots, not 381.
- **Timings seen** (the case's `durationMs` in the committed results.json, and the shot file times in the untracked `shots/case-2/`):
  - The case took 405 s, against 288 s in r1 and 295 s in r2.
  - Fixture 1, from the sheet to the post-timeout shot: 187 s, against 106 s for the whole fixture in r1. Most of that time came
    before the 15 s wait.
  - Fixtures 2 and 3: 86 s and 94 s, against 80 s each in r1.
- **What the screen shows.** `08-pad-scored` was taken after the timeout, about 3 minutes after that fixture's pad sheet opened. It
  reads 180/4 (20) against 14/0 (2), and an "End of over 3" tile is present and enabled. The tile was present by the time of that
  shot. When it arrived was not measured.
- **Unknown.** Whether the awaited locator was ever attached and not matched, whether the pad's sync or poll stalled, and what the
  machine was doing at the failing tap.
- **Hypothesis (not established): machine load.** One `uptime` sample exists, recorded in the gitignored task
  report. It read 232 / 199 / 114 (1, 5 and 15 minutes) at 13:52Z, about 4 minutes after the failing tap (about
  13:48Z, going by the activity times in the post-timeout shot). Fixture 2 ran at near-normal pace across that
  sample, which weakens the hypothesis. No sample exists at the failing tap.
- **Recurrence: not measured, because there is no single-sport scope.** `--set pad-proof` takes no `--only` (`run.ts:468-469`,
  `lib/pad-proof-set.ts:16`), so cricket cannot be run alone without a code change. The fresh-id rerun `w1c-pp-1280-r4` passed all 11
  sports, cricket with the same 9 = 3/0/6 split as the other clean runs. That is one more pass, not an explanation.
- **Routed to W1d:**
  - On a tap-wait timeout, capture tap timestamps or a trace before judging.
  - Give pad proof a single-sport scope, so recurrence can be measured.
  - No harness change was made in W1c.

## Runs 2 to 4 (screens)

Every run wrote 381 shots, except 1280 r3, which wrote 379: its red cricket fixture never reached Finalize. Between 326 and 333 of
each run's shots are distinct. The spread comes from timestamps and sync state, which differ from run to run. Each run had the same
steps as run 1, so run 1's verdicts stand for runs 2 to 4, and those shots were not read one by one again. The one screen that was
re-read is 1280 r3's cricket `08-pad-scored`, described under F-PP-1 above.
