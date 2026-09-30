# W1c L2 — the phone-width slice

`pnpm matrix:browser --layer L2 --run-id w1c-l2` (harness `b7668c0ff`, local standalone production build,
served hold 3000 ms, base `[local-base]`). Layer L2, driver browser, plan `--layer L2`: the committed
`catalogue/l2-pairs.json` rotation filtered to the six slice cells. EXIT 0, 51 s.

| state | cases |
|---|---|
| ✅ works | 3 |
| 🚫 no_path | 7 |
| ░ not_run | 58 |
| total | 68 |

The planned total is re-derived from the committed catalogue (1732 runs, 68 on the six slice cells): executed 3 +
🚫 7 + ░ 58 = 68; planned ids missing from the results 0, results outside the plan 0.

**Rotation shape.** 65 of the 68 runs land on swiss|badminton, 2 on swiss|generic (F8, P5b) and 1 on
knockout|badminton (Q4a); the league cells draw 0 runs from the committed rotation. So this run is phone
evidence for swiss|badminton, not for the slice as a whole — the knockout width sweep (`../w1c-sweep-ko/`) and
the pad proof at 320 (`../w1c-padproof/`) are the other phone evidence.

**Executed (the atoms with a harness script — LIFECYCLE, M1, R4a, F1):**

| case | width | checks | notable checks | pad ledger | shots |
|---|---|---|---|---|---|
| swiss\|badminton\|bwf\|R4a | 375 | 23 | r4-policy-reported 1, r4-cascade-consistent 4, r4-not-paired-later 12 | pass 3 (3 equal) | case-4 |
| swiss\|badminton\|bwf\|M1 | 390 | 22 | m1-walkover-recorded 2; m1-winner-progresses abstains (0 — a swiss has no bracket) | pass 3 | case-14 |
| swiss\|badminton\|bwf\|F1 | 375 | 22 | f1-everyone-drawn 7, f1-round-size 5 | pass 3 | case-26 |

**🚫 no_path (7), each "no organiser path, known at design time (design §4)":** R13 (W9, entrant moved to another
division after the draw), D1 (W9, two divisions merged), D2 (W9, one division split), D4a (W4, same-club
separation), D4b (W4, same-country separation), Q4a (W4, knockout final not played → joint winners), C5 (W5,
conduct points deduction applied to the table).

**░ not_run (58):** "no scenario script yet (atom X)" — plan D5: W1c writes no new scenario script. W1d owns the
per-cell L2 coverage.

**Parity against the HTTP slice** (`parity.md`): `compared 3 cases, 46 common checks, 0 differences; 21 HTTP
cases outside the browser plan; 65 planned without a harness script (🚫/░)` — PARITY.

## Which run exercised forfeit and withdraw (carry 8)

- **Withdraw**: the HTTP slice's R4 on all six cells, and in the browser only here — swiss|badminton R4a at 375
  (the entrants table's Withdraw control, its confirm dialog, then the product's withdraw route; shots
  `case-4/06-withdrawn-before`, `06-withdrawn`).
- **Forfeit (walkover)**: the HTTP slice's M1 on all six cells, and in the browser only here — swiss|badminton M1
  at 390 (the console's Forfeit… with reason "walkover"; shots `case-14/07-forfeit-before`, `07-forfeit`).
- Gap: neither runs at 1280 (L1 is LIFECYCLE only, ruling 39), and in the browser neither runs on a league or a
  knockout cell — the committed rotation drew only swiss|badminton. Owner wave: W1d.

## Per-screen verdicts

Read from contact sheets of every DISTINCT screen (duplicates collapsed by sha256). Each case's duplicates are
the expected first-visit baselines: `02-division-built` = `03-entrants-before`, `03-entrants` =
`04-started-before`, `04-started` = `run-sheet-all`. At 375/390 `04-started` differs from `05-generated-before`
because the harness opened the "Stage tools" fold between them. No `11-public` shot is taken for a non-LIFECYCLE
scenario.

### case-4 `swiss|badminton|bwf|R4a@375` — 21 shots, 18 distinct

| screen | verdict |
|---|---|
| 01-competition-created-before | ok — new-competition form |
| 01-competition-created | ok — the raw case id is the competition name (P-6, known) |
| 02-builder-basics | ok — Badminton / Bwf, match rules on Default |
| 02-builder-format | ok — Swiss selected; "What fits your day?" has no over-budget marker (P-9, known) |
| 02-division-built-before | ok — Scheduling step, "No courts yet", Create division |
| 02-division-built | ok — Draft, Add entrant form, empty table; ACTIONS header cut at the card edge (P-4 at 375) |
| 03-entrants | ok — 8 Registered, seeds 1–8; STATUS cut at the card edge (P-4) |
| 04-started | ok — Live, "Starting locks the setup", swiss stage "Waiting for the next round", 20 to schedule, 20 rows "TBD vs TBD · Awaiting draw"; "Stage tools ▾" closed |
| 05-generated-before | ok — the fold OPEN: Pair next round, Complete stage, Delete, Add match |
| 05-generated | ok — round 1 drawn 1v5, 2v6, 3v7, 4v8; "Unpair last round" now offered; the tools sheet stays open over the page (**N-5**) |
| 06-withdrawn-before | ok — Entrants tab, "This tournament has started — the entrant list is locked. Withdrawals still work; no one new can be added."; all 8 Registered |
| 06-withdrawn | ok for the state — Player 3 reads Withdrawn with Reinstate, the other seven Registered with Withdraw. **N-4 (new)**: the table is scrolled sideways to reach ACTIONS, and the right-edge scroll fade now sits across the middle of the STATUS column, washing out the "s" of "Registered" and "d" of "Withdrawn" on every row (`evidence/N-4-scroll-fade-stranded-375.png`) |
| 08-completed-before | ok — every fixture played; from round 2 on each round has one "has a bye · won (w/o)" row and Player 3 is never paired again; the round-1 fixture 3v7, drawn before the withdrawal, still carries "Matrix Player 3 won"; the tools sheet open (N-5) |
| 08-completed | ok — "Stage completed — that was the last stage, the division is finished 🏆"; Complete |
| 08-pad-before | ok — Match 1 Scheduled, Start match, Best of 3 · Game 1 0–0, Forfeit… / Abandon… |
| 08-pad-sheet | ok — In Play, POINTS — HOME 21, Confirm; Sanction / Set score in the half-width column (O-2, known) |
| 08-pad-scored | ok — Decided "2 – 0 · 21-16, 21-16" on one line at 375 (PF-1 is 320 only), Player 1 won, Activity 3, Ledger Verified |
| 10-standings | ok — P 5 for seven players and P 1 for Player 3 (Withdrawn chip); W 5, 4, 3, 3, 2, 1, 1, 1 (sum 20 = 4 round-1 matches + 4 rounds × (3 matches + 1 bye)); L sum 16 (byes carry no loss) |

**N-4 (new, visual defect).** `.scroll-x-fade::after` (`apps/web/src/app/globals.css:415-419`) is absolutely
placed at `right-0` of the SAME element that scrolls (`scroll-x` = `overflow-x-auto`, used together on
`entrants-panel.tsx:533`), so the fade scrolls with the content: once an organiser swipes the table, the fade is left
standing mid-table over whatever column is there. Seen on the entrants table at 375; the class is used by about
eighteen other files, which were not driven here, so how far it reaches is unmeasured. Product defect, not fixed
here.

**N-5 (soft, new as a numbered finding).** Below 768 the "Stage tools" bottom sheet stays open after Generate /
Pair next round. It covers the run sheet and the result notice, so the organiser closes it before they can see what
the press did. Every phone-width run shows this (here and in `../w1c-sweep-ko/`). Task 8 noticed it in passing
("sheet remains open", `../w1c-walkthrough-a/README.md`, 320 badminton `05-generated`) but gave it no id. An owner
question, not a defect claim.

### case-14 `swiss|badminton|bwf|M1@390` — 21 shots, 18 distinct

| screen | verdict |
|---|---|
| 01-* / 02-builder-* / 02-division-built* | ok — as case-4 at 390; P-6 and P-9 recur; ACTIONS header cut at the card edge (P-4 at 390) |
| 03-entrants | ok — 8 Registered; STATUS pill cut at the card edge (P-4) |
| 04-started | ok — Live, swiss stage waiting for round 1, 20 "TBD vs TBD"; "Stage tools ▾" closed |
| 05-generated-before | ok — fold OPEN (Pair next round …) |
| 05-generated | ok — round 1 drawn 1v5, 2v6, 3v7, 4v8; "Unpair last round" offered; sheet stays open (N-5) |
| 07-forfeit-before | ok — console for Player 1 vs Player 5, In Play, board 0–0, Activity 1 "Match started", sync pill mid-flight ("SYNCING…") |
| 07-forfeit | ok — pill **Forfeited**, "Matrix Player 1 won", Activity 2 "#2 Match forfeited", Ledger Verified, Finalize result offered |
| 08-completed-before | ok — the forfeited fixture struck through, "Round 1 · forfeited · Matrix Player 1 won (w/o)"; stage card "19 played" beside 20 fixtures — the walkover is not counted as played (observation, not a defect claim); sheet open (N-5) |
| 08-completed | ok — last stage completed, Complete |
| 08-pad-before / -sheet / -scored | ok — the pad fixture is Player 2 vs Player 6 (match 1 was forfeited); Decided "2 – 0 · 21-16, 21-16" on one line at 390 |
| 10-standings | ok — P 5 for all eight; W 5, 4, 3, 3, 2, 2, 1, 0 (sum 20 = 20 fixtures, the walkover counted as Player 1's win) |

### case-26 `swiss|badminton|bwf|F1@375` — 19 shots, 16 distinct (7 entrants)

| screen | verdict |
|---|---|
| 01-* / 02-* | ok — as case-4; P-6, P-9, P-4 recur |
| 03-entrants | ok — 7 Registered, seeds 1–7 (an odd field, F1's premise) |
| 04-started | ok — "5 rounds · 3 matches + 1 bye per round · 20 fixtures"; fold closed |
| 05-generated-before | ok — fold OPEN |
| 05-generated | ok — round 1 drawn 1v4, 2v5, 3v6; to schedule 20 → 19; sheet stays open (N-5) |
| 08-completed-before | ok — every round shows one "has a bye · won (w/o)" row: Player 7 (round 1), Player 6 (round 2), Player 5 (round 3) … — a different entrant each round |
| 08-completed | ok — last stage completed |
| 08-pad-before / -sheet / -scored | ok — Player 1 vs Player 4, Decided "2 – 0 · 21-16, 21-16" on one line |
| 10-standings | ok — P 5 for all seven; W 5, 4, 3, 3, 2, 2, 1 (sum 20 = 15 matches + 5 byes); L 0, 1, 2, 2, 3, 3, 4 (sum 15 = matches only) |

**L2 totals:** 3 cases, 61 shots, 52 distinct screens, every distinct screen has a verdict. Defect: **N-4** (new).
Soft: **N-5** (new). Known recurrences at 375/390: P-4, P-6, P-9, O-2. PF-1 does not appear (it is 320 only).
