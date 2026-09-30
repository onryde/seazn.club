# W1c L1 — the organiser's desk at 1280, three runs

Layer L1 (ruling 39: 1280 only), driver browser, plan `--layer L1`: the six slice cells
(league / knockout / swiss × generic / badminton) × LIFECYCLE. Harness `b7668c0ff`, local
standalone production build (served hold 3000 ms, re-proved by every run's preflight), base
`[local-base]`, fresh database `seazn_w1c-t14`.

## The three runs

Runs `w1c-l1-r1`, `w1c-l1-r2` and `w1c-l1-r3`, each exit 0 at harness `b7668c0ff` (clean tree). All 6 cases are ✅ in every run.
Each case records the same number of checks in every run, and each pad ledger passes with every row equal. Parity against the HTTP slice
is 0 differences in each run (`parity-r1.md`, `parity-r2.md`, `parity-r3.md`).

| L1 case (1280) | r1 | r2 | r3 | checks recorded r1 / r2 / r3 | pad ledger r1 / r2 / r3 |
|---|---|---|---|---|---|
| `league\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `league\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |
| `knockout\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `knockout\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |
| `swiss\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `swiss\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |

## Knockout and swiss score their first fixture on the pad (carry 1)

LIFECYCLE plays the first fixture of every cell on the ScoringPad (pad policy `first`) and the rest over
the product's own result route. This is the first live pad proof on knockout and swiss. In every run,
each of the four knockout/swiss cells passed `pad-ledger-as-generated`, with every row equal:

| cell | pad ledger (r1) | rows equal | screen |
|---|---|---|---|
| knockout\|generic | pass 2 | 2 of 2 | case-3 `08-pad-scored`: Decided 3 – 1 |
| knockout\|badminton | pass 3 | 3 of 3 | case-4 `08-pad-scored`: Decided "2 – 0 · 21-16, 21-16" |
| swiss\|generic | pass 2 | 2 of 2 | case-5 `08-pad-scored`: Decided 3 – 1 |
| swiss\|badminton | pass 3 | 3 of 3 | case-6 `08-pad-scored`: Decided "2 – 0 · 21-16, 21-16" |

Runs 2 and 3 give the same ledger counts (see the three-run table above).

## Notes the record owes

- **`l3Gap` is never recorded in these results (carry 4).** The committed L2 catalogue marks exactly one run
  `l3Gap`: run 514, `groups_ko|cricket|t20|M5@375` ("the L3 generator has no tie outcome … routed
  W1-driving"). That run is outside the six slice cells, and M5 has no scenario script (plan D5), so no W1c
  plan contains it and no W1c result can carry the mark. The type stays in `lib/pairs.ts` (the final review
  decides its fate). It will first be recorded when an L2 run grows past the slice to groups_ko (W1d), and
  the tie outcome it names is owed by W1-driving.
- **The committed walkthrough-a results at 320 read `L1` (carry 7).** `../w1c-walkthrough-a/w1c-wa-320*/results.json`
  were written before `layerOfWidth` existed, when every browser run was labelled L1. They are history and
  are not rewritten. Read them as L2-width evidence: by ruling 39, L1 is 1280 only.

## Per-screen verdicts — run 1 (`w1c-l1-r1`)

Read from contact sheets of every DISTINCT screen (duplicates collapsed by sha256 and named).
A verdict says what the screen shows, not what it must show. "ok" = the state the step claims
is on screen and nothing on it contradicts the case's own checks.

### case-1 `league|generic|score|LIFECYCLE@1280` — 34 shots, 29 distinct

Duplicates (identical bytes): `02-division-built` = `03-entrants-before`; `03-entrants` =
`04-started-before`; `04-started` = `05-generated-before` = `run-sheet-all`; `05-generated-before-8` =
`08-completed-before`. Every other "before" differs from its "after".

| screen | verdict |
|---|---|
| 01-competition-created-before | ok — new-competition form, synthetic name |
| 01-competition-created | ok — competition page; breadcrumb carries the raw cell id "Matrix league\|generic\|score\|LIFECYCLE" (P-6, known) |
| 02-builder-basics | ok — division builder, basics step |
| 02-builder-format | ok — League picked; no over-budget marker shown (P-9, known) |
| 02-division-built-before | ok — builder review before submit |
| 02-division-built | ok — division page, Entrants tab; add-entrant form shows hardcoded English (known, `entrants-panel.tsx`) |
| 03-entrants | ok — 8 entrants, all Registered |
| 04-started | ok — Live pill; "Starting locks the setup" notice; stage card Generate fixtures / Complete stage (primary) / Delete / Add match; 28 to schedule; filter "All" pressed; times shown in UTC |
| run-sheet-all (carry 2) | ok — filter already on "All" at first visit, so ONE shot, byte-identical to 04-started; the before/after pair is taken only when the press changes the sheet |
| 05-generated (first loop) | ok — "Nothing new to generate — fixtures are up to date." (a league builds every round at start); 28 not yet scheduled |
| 05-generated-before-2 … -8, 05-generated-2 … -8 | ok — seven loops; played-not-scheduled grows 4 → 8 → … → 28, not-yet-scheduled shrinks to none; each played row shows Result and "Player N won" or "Draw"; Delete leaves the stage card once a result exists |
| 08-completed | ok — "Stage completed — that was the last stage, the division is finished 🏆"; stage pill Complete; 28 played |
| 08-pad-before | ok — Match 1 scheduled; pad board HOME / AWAY; Start match; Enter final score; Forfeit… / Abandon… under Match actions |
| 08-pad-sheet | ok — In Play; final-score sheet open with HOME SCORE stepper at 3, Confirm |
| 08-pad-scored | ok — Decided 3 – 1, "Matrix Player 1 won"; Activity 2 (Match started, Result recorded 3 – 1); Ledger Verified; Finalize result |
| 10-standings | ok — 8 rows, P 7 each; points 17/16/11/10/10/6/4/1 = 3W + D on every row; W 19 = L 19, D 18 (9 draws) over 28 matches; tie-break cascade printed |
| 11-public | ok — public page: Champion Matrix Player 1; standings identical to the desk's |

### case-2 `league|badminton|bwf|LIFECYCLE@1280` — 34 shots, 29 distinct

Duplicates as case-1 (`02-division-built` = `03-entrants-before`, `03-entrants` = `04-started-before`,
`04-started` = `05-generated-before` = `run-sheet-all`, `05-generated-before-8` = `08-completed-before`).

| screen | verdict |
|---|---|
| 01-competition-created-before, 01-competition-created | ok — raw cell id as the competition name (P-6, known) |
| 02-builder-basics | ok — Badminton / Bwf, match rules left on Default |
| 02-builder-format | ok — League picked; P-9 (no over-budget marker) recurs |
| 02-division-built-before, 02-division-built | ok — Scheduling step, then the division page, Draft; Discipline tab present (badminton) |
| 03-entrants | ok — 8 Registered, seeds 1–8, Withdraw / Delete per row |
| 04-started | ok — Live; match format Best of 3 · Same as division; 28 to schedule |
| 05-generated, 05-generated-before-2 … -8, 05-generated-2 … -8 | ok — "Nothing new to generate"; played grows by 4 a loop to 28, not-yet-scheduled empties |
| 08-completed | ok — last stage completed, Complete, 28 played |
| 08-pad-before | ok — Match 1 Scheduled, board 0–0, per-side lineup cards, Forfeit… / Abandon… |
| 08-pad-sheet | ok — In Play; POINTS — HOME 21, Confirm; Sanction Home / Sanction Away / Set score |
| 08-pad-scored | ok — Decided "2 – 0 · 21-16, 21-16" on ONE line at 1280 (PF-1 is phone-only), Activity 3, Ledger Verified |
| 10-standings | ok — W 7…0 (sum 28), games won 2W, PTS 2W (14…0), ratio "∞" for the unbeaten row |
| 11-public | ok — Champion Matrix Player 1, table identical |

### case-3 `knockout|generic|score|LIFECYCLE@1280` — 26 shots, 21 distinct

Duplicates: `02-division-built` = `03-entrants-before`, `03-entrants` = `04-started-before`, `04-started` =
`05-generated-before` = `run-sheet-all`, `05-generated-before-4` = `08-completed-before`.

| screen | verdict |
|---|---|
| 01-* / 02-* / 03-entrants | ok — as case-1, Knockout picked in the builder |
| 04-started | ok — bracket QF 1v8, 5v4, 3v6, 7v2 with "Winner of R1-n" placeholders; 7 to schedule |
| 05-generated (first) | ok — "Nothing new to generate" (a knockout builds every round at start); Delete still offered |
| 05-generated-before-2 … -4, 05-generated-2 … -4 | ok — QF → SF → Final resolve in the bracket and the run sheet; results "3 — 1" / "1 — 3" fit their nodes |
| 08-completed | ok — Complete, 7 played |
| 08-pad-before / -sheet / -scored | ok — generic pad, Decided 3 – 1 |
| 10-standings | ok — "No table stages in this division" (a knockout has no table) |
| 11-public | ok — Champion Matrix Player 1, public bracket with results |

### case-4 `knockout|badminton|bwf|LIFECYCLE@1280` — 26 shots, 21 distinct

Duplicates as case-3.

| screen | verdict |
|---|---|
| 01-* / 02-* / 03-entrants / 04-started | ok — as case-3, badminton, Discipline tab |
| 05-generated … 05-generated-4, 05-generated-before-2 … -4 | ok as a flow — **N-1** from the first result on: each node's "2 — 0 · 21–16, 21–16" is drawn over the top entrant's name (`evidence/N-1-bracket-score-over-name-1280.png`, a crop of `08-completed.png`) |
| 08-completed | defect **N-1** (new) — otherwise ok: Complete, 7 played |
| 08-pad-before / -sheet / -scored | ok — Decided "2 – 0 · 21-16, 21-16" |
| 10-standings | ok — no table stages |
| 11-public | ok — Champion Matrix Player 1; the PUBLIC bracket puts each score on its own line (no N-1 there) |

### case-5 `swiss|generic|score|LIFECYCLE@1280` — 20 shots, 16 distinct

Duplicates: `02-division-built` = `03-entrants-before`, `03-entrants` = `04-started-before`, `04-started` =
`05-generated-before` = `run-sheet-all`.

| screen | verdict |
|---|---|
| 01-* / 02-* / 03-entrants | ok — Swiss picked |
| 04-started | ok — 20 rows "TBD vs TBD · Awaiting draw" over 5 rounds, Unscheduled 20 |
| 05-generated | ok — "Generated 4 fixture(s) (0 already existed)." (the "(s)" is N-2, soft); round 1 drawn 1v5, 2v6, 3v7, 4v8 (top half against bottom half), rounds 2–5 still awaiting draw |
| 08-completed-before, 08-completed | ok — all 20 played, then Complete |
| 08-pad-before / -sheet / -scored | ok — Decided 3 – 1 |
| 10-standings | ok — P 5 each; PTS = 3W + D on every row (13, 12, 8, 7, 5, 5, 3, …) |
| 11-public | ok — Champion Matrix Player 1, table identical |

### case-6 `swiss|badminton|bwf|LIFECYCLE@1280` — 20 shots, 16 distinct

Duplicates as case-5.

| screen | verdict |
|---|---|
| 01-* … 05-generated | ok — as case-5, badminton |
| 08-* | ok — Decided "2 – 0 · 21-16, 21-16" on one line |
| 10-standings | ok — P 5; W 5, 4, 3, 3, 2, 2, 1, …; games won = 2W; PTS = 2W; ratio "∞" for the unbeaten row |
| 11-public | ok — Champion Matrix Player 1 |

**Run 1 totals:** 6 cases, 160 shots, 132 distinct screens read; every distinct screen has a verdict above.
Defects: N-1 (new, case-4, and live in every knockout|badminton screen after the first result). Soft:
N-2 "fixture(s)". Known recurrences: P-6, P-9, the add-entrant form's hardcoded English. No harness
defect: every after-shot differs from its before-shot except the named first-visit baselines.

## Runs 2 and 3 (`w1c-l1-r2`, `w1c-l1-r3`)

Each run wrote 160 shots, which collapse to 132 distinct screens, exactly as run 1 did. The flow and the step
set are the same. Run 1's verdicts stand for these screens, and they were not read one by one again. The one
screen re-read in run 3 is case-4 `08-completed`, where **N-1 recurs**: every bracket node's "2 — 0 · 21–16,
21–16" is drawn over the top entrant's name.
