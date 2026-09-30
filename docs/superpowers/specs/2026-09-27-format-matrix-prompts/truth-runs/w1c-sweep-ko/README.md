# W1c width sweep — knockout|badminton LIFECYCLE at every L2 width

Seven plain browser runs, one per width: `pnpm matrix:browser --width W --only 'knockout|badminton'
--scenario LIFECYCLE --run-id w1c-sweep-ko-W` (harness `b7668c0ff`, local standalone production
build, base `[local-base]`). A plain run at a phone width is labelled L2 by `layerOfWidth`, so each
MATRIX.md header reads `Layer L2 · driver browser · plan slice --only knockout|badminton --scenario LIFECYCLE`.

Why knockout and not the committed `--set width-sweep`: that set is hard-wired to league|badminton
(`lib/layers.ts`); running the sweep on a knockout slice cell, and including 768/834, is the controller's
recommendation for Task 14 (not an owner ruling). The league sweep is the set's own definition and is
not re-run here.

| width | state | checks / items | pad ledger | no-horizontal-scroll | EXIT | secs |
|---|---|---|---|---|---|---|
| 320 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 21 |
| 360 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 25 |
| 375 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 28 |
| 390 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 22 |
| 430 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 20 |
| 768 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 22 |
| 834 | ✅ works | 19 / 149 | pass 3 (3 equal) | pass 26 | 0 | 25 |

## The stage-rail fold, per width (read from the pictures)

`openFoldIfFolded` clicks the "Stage tools" trigger only when it is visible, and the results do not
record which branch ran — so the fold is settled from the pictures, compared across the seven widths
on one sheet per screen (`04-started`, `05-generated-before`, `05-generated`).

| width | 04-started | 05-generated-before | verdict |
|---|---|---|---|
| 320, 360, 375, 390, 430 | "Stage tools ▾" closed; Generate / Complete / Delete not on the page | the tools sheet open (Generate fixtures, Complete stage, Delete, Required court tags, To schedule 7), trigger reads "▴" | ok — the harness OPENED the fold before Generate |
| 768 | no "Stage tools" trigger; the tools sit inline on the stage card | byte-identical to 04-started (sha `542cf2b4…`) | ok — nothing was clicked; the trigger is `md:hidden` |
| 834 | no trigger; tools inline | 25 pixels differ inside one 315×197 box of the run sheet (a row state, not a sheet — an open sheet would repaint most of the page) | ok — nothing was clicked |

A full-page capture paints the fixed bottom sheet at the top of the image (over the bracket); that is
the capture, not the page.

## Per-screen verdicts (every distinct screen, every width)

Distinct screens: 320 → 23 of 26; 360 / 375 / 390 / 430 / 834 → 22; 768 → 21. Duplicates are the
expected ones (`02-division-built` = `03-entrants-before`, `03-entrants` = `04-started-before`,
`05-generated-before-4` = `08-completed-before`, and at 768 the fold-less `04-started` =
`05-generated-before` = `run-sheet-all`).

Read one screen at a time across all seven widths on a single sheet (`w` 320 → 834, left to right).

| screen | 320 | 360 · 375 · 390 | 430 | 768 · 834 | verdict |
|---|---|---|---|---|---|
| 01-competition-created-before | form, name field truncates | form | form | form, two-column date row | ok ×7 |
| 01-competition-created | title ellipsised, Schedule Board / Registration / More | same | same | full title, action row | ok ×7 |
| 02-builder-basics | Basics tab, sport Badminton, variant Bwf, match rules on Default | same | same | same, two-column rules | ok ×7 |
| 02-builder-format | "What fits your day?" 16 / 2 / 4 h: Knockout ≈3.8 h, Double elimination ≈7.5 h, Groups + knockout ≈7.8 h with no over-budget marker; Knockout selected | same | same | same | ok ×7, P-9 recurs at every width |
| 02-division-built-before | Scheduling tab, "No courts yet", Create division | same | same | same | ok ×7 |
| 02-division-built | Draft, Add entrant form, empty table; STATUS header at the card edge | STATUS/ACTIONS cut at the card edge | fits | fits | ok ×7, P-4 at 320–390 |
| 03-entrants | 8 Registered, seeds 1–8; names wrap word-per-line, STATUS off-card | same, STATUS clipped | fits | fits | ok ×7, P-4 at 320–390 (wider than Task 8 recorded: 320 only) |
| 04-started, run-sheet-all | Live; fold CLOSED (see above); bracket R1 pairs + "Winner of R1-1"; 7 to schedule; filter "All" | same | same | tools inline | ok ×7 |
| 05-generated-before (-2, -3, -4) | fold OPEN; to schedule 7 → 3 → 1 → 0; played rows "Round 1 · Matrix Player 1 won" + Result | same | same | tools inline | ok ×7 each |
| 05-generated (-2, -3, -4) | "Nothing new to generate — fixtures are up to date." (the O-1 no-op: a knockout, like a league, builds every round at Start); the tools sheet stays open over the page (**N-5**) | notice under the sheet in the full-page capture | same | notice inline | ok ×7 each |
| 08-completed | "Stage completed — that was the last stage, the division is finished 🏆"; Complete; sheet now holds only Required court tags | same | same | inline | ok ×7 — and **N-1** in the bracket |
| 08-pad-before | Match 1, Scheduled, Start match, board Best of 3 · Game 1 0–0, Recording Every detail, Forfeit… / Abandon… | same | same | same, desktop console | ok ×7 |
| 08-pad-sheet | In Play; POINTS — HOME 21 stepper, Confirm; Sanction Home / Sanction Away / Set score in a half-width left column (O-2, known) | same | same | tiles in a row | ok ×7 |
| 08-pad-scored | Decided "2 – 0 · 21-16, 21-" / "16" WRAPS (PF-1, known), "Matrix Player 1 won", Activity 3, Ledger Verified | one line | one line | one line | ok ×7; PF-1 at 320 only |
| 10-standings | "No table stages in this division — standings apply to league, group and swiss stages." | same | same | same | ok ×7 (a knockout has no table) |
| 11-public | Champion Matrix Player 1; bracket with each score on its own line, swipes sideways inside its box | same | same | whole bracket | ok ×7 |

### N-1 (new) — the organiser bracket draws a badminton result over the top entrant's name

On the division page's Fixtures tab, each bracket node puts its result top-right, absolutely placed
(`bracket-panel.tsx:334`, `absolute right-2 top-1.5`). A generic "3 — 1" fits; a badminton result
"2 — 0 · 21–16, 21–16" runs across the first entrant's name at EVERY width, 320 through 1280, so the
name and the score are both hard to read. The public page's bracket puts the same string on its own
line and is fine. Evidence: `evidence/N-1-bracket-score-over-name-768.png` (crop of
`w1c-sweep-ko-768/shots/case-1/08-completed.png`); the same at 390 (`w1c-sweep-ko-390`, same shot)
and at 1280 (`w1c-l1/evidence/N-1-bracket-score-over-name-1280.png`). Product defect, not fixed here.

### N-5 (soft) — the Stage tools sheet stays open after Generate

At 320–430, once Generate is pressed, the bottom sheet stays open over the page and hides the notice that
says what the press did. At 768/834 the tools sit inline, so there is no sheet to leave open. The full
definition is in `../w1c-l2/README.md` (N-5). This is an owner question, not a defect claim.
