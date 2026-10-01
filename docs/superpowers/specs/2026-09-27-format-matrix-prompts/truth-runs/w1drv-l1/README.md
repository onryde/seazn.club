# W1-driving L1: one cell per capability at 1280, plus the two template cards, in three runs

Layer L1 (ruling 39: 1280 only), driver browser, plan `--set w1-driving-l1` (W1-driving Task 13). There are seven
LIFECYCLE cases. Five are capability cells: team rosters on football, the multi-stage seed advance, the ladder,
americano and mexicano. The other two are the template-only cells, built through their gallery cards (ruling 47). Each
template cell runs on its template's own sport and variant (D11). D13 applies: no cricket `test` case is in the set.

All three runs use harness `3ef0ab26e` on a clean tracked tree, in one fresh `seazn-local-env` stand-up (label
`w1drvt13`):

- Postgres at v426, built with `db:apply` + `sync:sports`. `show data_directory` equals `BENCH_EXPECTED_DATA_DIR`.
- The standalone production build was rebuilt from this tree with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`. Every run's
  preflight re-proved that the served hold matches the shell's.
- No `REDIS_URL`. PostHog and Sentry keys were blanked, and 0 static chunks carry either.

The first attempt at r1 refused before any case ran (`ServedHoldUnreadable`). Its build lacked the hold window, which
was an environment fault. It wrote no results; the run id was reused once the build was fixed.

## The three runs

| L1 case (1280) | r1 | r2 | r3 | checks r1 / r2 / r3 | how it was built |
|---|---|---|---|---|---|
| `league\|football\|11-a-side\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 23 / 23 / 23 | blank wizard + division builder |
| `groups_ko\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 25 / 25 / 25 | blank wizard + division builder |
| `ladder\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 19 / 19 / 19 | blank wizard + division builder |
| `americano\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 18 / 18 / 18 | blank wizard + division builder |
| `mexicano\|generic\|score\|LIFECYCLE@1280` | ❌ red | ❌ red | ❌ red | 20 / 20 / 20 | blank wizard + division builder |
| `group_only\|badminton\|short\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 20 / 20 / 20 | gallery card `template-card-box-league` |
| `group_group_ko\|cricket\|t20\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 23 / 23 / 23 | gallery card `template-card-t20-super8` |

Runs r1 and r2 are identical case by case. Every check has the same verdict and the same `checked` count
(`summ` diff empty). r3 is identical to r1 in the same way, and its duplicate grouping matches r1's too (16 distinct shots on case-4 and case-5). The server log holds the mexicano 500 exactly three times, once per run.

Every run exits 0, with `vacuous: none` and `error reds: none`. `no-horizontal-scroll` passes on every shot of every
case at 1280: r1 has 33 / 20 / 18 / 18 / 19 / 22 / 16 shots, case by case.

**The red, recorded, not triaged.** mexicano|generic: round 2's generate answered `500 INTERNAL`. The server log
holds one `v1: unhandled error | duplicate key value violates unique constraint "entrant_members_pkey"` per run. The
harness wrote the note `mexicano-pair-entrants-counted-as-players: round 2 generate refused 500 INTERNAL … → W7`.
That is the product red W1-driving Task 8 predicted. It fails `I4-nothing-ends-stuck`, `I8-generate-named`,
`life-draw-path-exercised` and `life-loop-bounded`.

**The template cards (ruling 47).** Both template cases have no `organiser-ui-path` and no `builder-posted-as-harness`
check: the card built the division, not the builder. `mixed-driver-coverage` passes with 9 action types, 0 exempt.
Each case's first two shots are the card's detail sheet and the competition page it landed on.

**G-1, league|football.** The lineups put `life-lineups-put` at 56 across 28 team fixtures. `pad-ledger-as-generated`
passes 4, and the first fixture was scored on the pad 1–0 behind both lineup editors.

## Per-screen verdicts: run 1 (`w1drv-l1-r1`)

These were read from contact sheets of every DISTINCT shot, with byte-identical shots collapsed (sha256) and named.
A verdict says what the screen showed. "ok" means the state the step claims is on screen and nothing on the screen
contradicts the case's own checks. "obs" means the screen showed something recorded under the observations below.

### case-1 `league|football|11-a-side|LIFECYCLE@1280`: 33 shots, 29 distinct

Duplicates: `02-division-built` = `03-entrants-before`; `04-started` = `05-generated-before` = `run-sheet-all`;
`05-generated-before-8` = `08-completed-before`.

| shot | what it showed | verdict |
|---|---|---|
| 01-competition-created-before | The New competition form, named `Matrix league\|football\|11-a-side\|LIFECYCLE`, with "Link only" selected and Ends on 31/12/2030 | ok |
| 01-competition-created | The competition page "MATRIX LEAGUE\|FOOTBALL\|11-A-SIDE\|LIFECYCLE", Setting up, 0 divisions | ok |
| 02-builder-basics | New division: "Matrix football", Sport Football, Variant 11 A Side, with the football match-rule fields | ok |
| 02-builder-format | The Format tab with the format cards; League is selected and Legs is "Single round robin" | ok |
| 02-division-built-before | The Scheduling tab (match length 90) with "No courts yet" | ok |
| 02-division-built | The division "MATRIX FOOTBALL", Football · 11-A-Side, Draft, Entrants tab, Team kind, no entrants yet | ok |
| 03-entrants | 8 entrants, Matrix Player 1–8, kind Team, all Registered | ok, obs (e) |
| 04-started-before | The same 8 teams; the add form's member field lists Matrix Player 1.1–1.8 | ok |
| 04-started | Live, Fixtures tab, "1. League · Active", 28 to schedule, rounds 1–7 not yet scheduled | ok |
| 05-generated-2 … -8 / -before-2 … -7 | "Nothing new to generate — fixtures are up to date" each pass; the played-not-scheduled list grows each pass | ok |
| 05-generated | Rounds listed, with the "Starting locks the setup" banner | ok |
| 08-completed | "Stage completed — that was the last stage, the division is finished", 28 played | ok |
| 08-pad-before | Matrix Player 1 vs Matrix Player 8, Scheduled, pad 0–0 "Start match", and both lineup editors with the starting XI and bench | ok |
| 08-pad-sheet | The pad mid-entry | ok |
| 08-pad-scored | Decided 1 – 0, Matrix Player 1 won, activity rows, "Ledger Verified" | ok |
| 10-standings | League table, P 7 each: Matrix Player 1 on 17 pts, then 16, 11, 10, 10, 6, 4, 1 | ok |
| 11-public | The public page with the same table and "Champion Matrix Player 1" | ok |

### case-2 `groups_ko|badminton|bwf|LIFECYCLE@1280`: 20 shots, 16 distinct

Duplicates: `02-division-built` = `03-entrants-before`; `03-entrants` = `04-started-before`; `04-started` =
`05-generated-before` = `run-sheet-all`.

| shot | what it showed | verdict |
|---|---|---|
| 01-competition-created-before / 01-competition-created | The wizard, then "MATRIX GROUPS_KO\|BADMINTON\|BWF\|LIFECYCLE", Setting up | ok |
| 02-builder-basics / -format / 02-division-built-before | Badminton / Bwf. Groups + Knockout is selected with Pools 2 and Qualify to finals "Top 4". Scheduling: match length 40 | ok |
| 02-division-built | "MATRIX BADMINTON", Draft, Individual kind, no entrants | ok |
| 03-entrants | 8 individuals, Matrix Player 1–8, Registered | ok |
| 04-started | Live. "1. Group stage · Active", 12 to schedule; "2. Knockout · Pending" with no fixtures yet | ok |
| 05-generated | The Bracket strip and "Generated 3 fixture(s)". The knockout semis read "Winner of Group A vs Runner-up of Group B — Awaiting draw" | ok |
| 08-completed-before | The group stage's fixtures played; the knockout is still awaiting its draw | ok |
| 08-completed | "Stage completed". The Knockout panel shows "Proposed qualifiers" (seeds 1–4 from Pool A/B ranks) with "Confirm proposal" | ok, obs (d) |
| 08-pad-before / -sheet / -scored | Matrix Player 1 vs Matrix Player 8. The pad goes 0–0, then mid-entry 21, then Decided "2 – 0 · 21-16, 21-16" | ok |
| 10-standings | Group stage Pool A and Pool B, 4 players each | ok |
| 11-public | "Champion Matrix Player 1". Pools A/B, then Knockout semi-finals and final with scores | ok |

### case-3 `ladder|generic|score|LIFECYCLE@1280`: 18 shots, 16 distinct

Duplicates: `02-division-built` = `03-entrants-before`; `03-entrants` = `04-started-before`.

| shot | what it showed | verdict |
|---|---|---|
| 01-… / 02-builder-basics / -format / 02-division-built-before | The wizard; Generic / Score; Ladder selected; Scheduling with match length 30 | ok |
| 02-division-built / 03-entrants | "MATRIX GENERIC", Draft; then 8 individuals, Registered | ok |
| 04-started | The Ladder table (ranks 1–8 = Matrix Player 1–8), the Challenger form, and "1. Ladder · Active", no fixtures yet | ok |
| run-sheet-all | Live, one challenge not yet scheduled: Matrix Player 8 vs Matrix Player 7 | ok |
| 08-completed-before | The ladder reordered (Matrix Player 2 at rank 1), 7 challenges played (one a draw) | ok |
| 08-completed | "Stage completed", the Ladder · Complete, 7 played | ok |
| 08-pad-before / -sheet / -scored | Matrix Player 8 vs Matrix Player 7. The pad shows "Enter final score", then home 3, then Decided 3 – 1 | ok |
| 10-standings | "No table stages in this division — standings apply to league, group and swiss stages." | ok |
| 11-public | "Champion Matrix Player 2". The Ladder table in rank order with P / W / L / PTS 0 on every row | obs (b) |

### case-4 `americano|badminton|bwf|LIFECYCLE@1280`: 18 shots, 16 distinct

Duplicates: `02-division-built` = `03-entrants-before`; `04-started` = `run-sheet-all`.

| shot | what it showed | verdict |
|---|---|---|
| 01-… / 02-builder-* / 02-division-built-before | The wizard; Badminton / Bwf; Americano (padel) selected; Scheduling | ok |
| 02-division-built / 03-entrants / 04-started-before | "MATRIX BADMINTON", Draft; 8 individuals | ok |
| 04-started | Live. "Rotation · Americano", rounds 1–7 with two courts each, and 14 fixtures to schedule | ok |
| 08-completed-before / 08-completed | Personal points: every player 0 PTS with 7 games. Round cards read "– –"; results in the list ("Matrix Player 4 / Matrix Player 1 won"). Then "Stage completed" | obs (c) |
| 08-pad-before / -sheet / -scored | Matrix Player 1 / Matrix Player 4 vs Matrix Player 2 / Matrix Player 3. The pad has pair lineups, then 21, then Decided "2 – 0 · 21-16, 21-16" | ok |
| 10-standings | "No table stages in this division …" | ok |
| 11-public | "Champion Matrix Player 2 / Matrix Player 5". The Americano table lists pair entrants | obs (c) |

### case-5 `mexicano|generic|score|LIFECYCLE@1280` (red): 19 shots, 16 distinct

Duplicates: `02-division-built` = `03-entrants-before`; `04-started` = `run-sheet-all`; `05-generated-before` =
`08-completed-before`.

| shot | what it showed | verdict |
|---|---|---|
| 01-… / 02-builder-* / 02-division-built-before | The wizard; Generic / Score; Mexicano (padel) selected; Scheduling | ok |
| 02-division-built / 03-entrants / 04-started-before | "MATRIX GENERIC", Draft; 8 individuals | ok |
| 04-started | Live. Rotation · Mexicano, Round 1 with two courts and score boxes, and 2 fixtures to schedule | ok |
| 05-generated-before | Personal points after round 1 (3 / 3 / 3 / 3 / 1 / 1 / 1 / 1), and round 1 both courts scored 3 1. No round 2 is on screen | ok (the red's state) |
| 08-completed | "Stage completed", Mexicano · Complete, 2 played | ok |
| 08-pad-before / -sheet / -scored | Matrix Player 3 / Matrix Player 5 vs Matrix Player 4 / Matrix Player 6. The pad goes to home 3, then Decided 3 – 1 | ok |
| 10-standings | "No table stages in this division …" | ok |
| 11-public | "Champion Matrix Player 5 / Matrix Player 3". The Mexicano table lists 4 pair entrants | obs (c) |

### case-6 `group_only|badminton|short|LIFECYCLE@1280`: through the box-league card, 22 shots, 18 distinct

Duplicates: `03-entrants` = `04-started-before`; `04-started` = `05-generated-before` = `run-sheet-all`;
`05-generated-before-4` = `08-completed-before`. There is no `02-*` shot: the card replaces the builder.

| shot | what it showed | verdict |
|---|---|---|
| 01-competition-from-template-before | The gallery behind the "Box League" detail sheet. Name `Matrix group_only\|badminton\|short\|LIFECYCLE`, Ends on 31/12/2030, "Small round-robin boxes run in parallel", Structure "Singles — Group Stage · 16 entrants", and "Use this template" | ok |
| 01-competition-from-template | "MATRIX GROUP_ONLY\|BADMINTON\|SHORT\|LIFECYCLE", Setting up, Badminton, 1 division: Singles · Groups · 0 entrants | ok |
| 03-entrants-before | "SINGLES", Badminton · Short, Draft, Individual kind, "No entrants registered yet" | ok |
| 03-entrants | 16 individuals, Matrix Player 1–16, Registered | ok |
| 04-started | Live. "1. Boxes · Group · Active", Best of 3, 24 to schedule, round 1 fixtures | ok |
| 05-generated-* / -before-* | "Nothing new to generate — fixtures are up to date"; the played list grows each pass | ok |
| 08-completed | "Stage completed — that was the last stage, the division is finished", 24 played | ok |
| 08-pad-before / -sheet / -scored | Matrix Player 1 vs Matrix Player 16. The pad goes to 11, then Decided "2 – 0 · 11-6, 11-6" | ok |
| 10-standings | Boxes — Pool A, B, C and D, 4 players each | ok |
| 11-public | "SINGLES", Badminton · SHORT (3 POINTS). "Champion Matrix Player 1" above the four box tables | obs (a) |

### case-7 `group_group_ko|cricket|t20|LIFECYCLE@1280`: through the t20-super8 card, 16 shots, 14 distinct

Duplicates: `04-started` = `05-generated-before` = `run-sheet-all`. There is no `02-*` shot.

| shot | what it showed | verdict |
|---|---|---|
| 01-competition-from-template-before | The "T20 Super 8 — 16 teams" detail sheet: name, Ends on 31/12/2030, and Structure Tournament → Group Stage → Super 8 → Knockout | ok |
| 01-competition-from-template | "MATRIX GROUP_GROUP_KO\|CRICKET\|T20\|LIFECYCLE", 1 division: Tournament, Setting up | ok |
| 03-entrants-before | "TOURNAMENT", Cricket · T20, Draft, Team kind, no entrants | ok |
| 03-entrants / 04-started-before | 16 team entrants, Matrix Player 1–16. The second shot shows the add form's member field filled | ok, obs (e) |
| 04-started | Live. Group Stage · Active, Super 8 and Knockout pending, group round fixtures listed | ok |
| 05-generated | Group Stage, Super 8 and Knockout panels, with Super 8 fixtures as "Winner of Group A vs Runner-up of Group B" | ok |
| 08-completed-before | The Bracket strip, the knockout awaiting its draw, the group fixtures played | ok |
| 08-completed | The Super 8 seed proposal table (seeds 1–8 from group ranks) with "Confirm proposal", and the group stage Complete | ok |
| 08-pad-before | Matrix Player 1 vs Matrix Player 16, Scheduled, pad 0/0 with "Toss", and both lineups (11 starting + bench) | ok |
| 08-pad-sheet | In play. The ball buttons (0 1 2 3 4 6 Wide, Wicket, No-ball …) and "End of over 1" | ok |
| 08-pad-scored | Decided "180/4 (20) – 150/5 (20)", Matrix Player 1 won, "Ledger Verified" | ok |
| 10-standings | Group Stage Pools A–D and Super 8 Pools A/B, with NRR columns | ok |
| 11-public | "Champion Matrix Player 1". Pools, Super 8, then Knockout semi-finals and final with scores | ok |

## Observations (what the screens showed; triage is Task 15's)

- **(a)** box-league: the public page crowns ONE champion ("Matrix Player 1") above four parallel boxes.
- **(b)** ladder: the public standings show P / W / L / PTS 0 on every rung after 7 decided challenges. The rank order
  is the ladder's.
- **(c)** americano|badminton: the Rotation "Personal points" read 0 for every player after 7 rounds with results
  recorded. Both americano and mexicano public pages list minted pair entrants as the table, with a pair as champion.
  The harness's own note on both: `americano-minted-pairs-block-kind-edit … → W7`.
- **(d)** groups_ko: `08-completed` is the group stage's completion with the knockout's seed proposal pending. No shot
  shows the knockout's own completion; the public page (`11-public`) shows the final played.
- **(e)** Team entrants are named "Matrix Player N", with members "Matrix Player N.M". The house constraint names
  them "Matrix Team N". This is pre-existing harness naming, not this task's change.
- **(f)** Across runs, the duplicate grouping differs slightly. In r2, case-4 and case-5 have 17 distinct shots
  against the 16 in r1 and r3, because `04-started` and `run-sheet-all` stopped being byte-identical. That is timing, not a
  different state: verdicts and counts are identical.

## Task 15: three more runs at the T15 head, and the triage of (a)–(f)

**The env.** One fresh `seazn-local-env` stand-up, label `w1drvt15`. It is the same env as the ruling-48 L3 run (`../w1drv-l3`):

- Postgres at v428, built with `db:apply` + `sync:sports`;
- a production build with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`, which the preflight re-proved on every run.

**The runs.** `pnpm matrix:browser --set w1-driving-l1 --run-id w1drv-l1-t15-r{1,2,3}`, one after the other, on harness `63bda33e4` (clean). Each exited 0 in about 3 min 40 s (15:30:41–15:41:43 UTC in all), with `vacuous: none` and `error reds: none`.

| L1 case (1280) | t15-r1 | t15-r2 | t15-r3 | checks (each run) |
|---|---|---|---|---|
| `league\|football\|11-a-side\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 23 |
| `groups_ko\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 25 |
| `ladder\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 19 |
| `americano\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 18 |
| `mexicano\|generic\|score\|LIFECYCLE@1280` | ❌ red | ❌ red | ❌ red | 20 |
| `group_only\|badminton\|short\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 20 |
| `group_group_ko\|cricket\|t20\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 23 |

- **Identical across all three runs.** In t15-r2 and t15-r3, every case has the same state and every check the same verdict and `checked` count as in t15-r1.
- **Identical to T13.** t15-r1 also equals T13's `w1drv-l1-r1` on all 206 checks, with 0 differences. The harness fixes between them (F1 / M1 / the mexicano duplicate note) touch nothing the L1 set checks.
- **Scroll.** `no-horizontal-scroll` passes on every shot: 33 / 20 / 18 / 18 / 19 / 22 / 16 shots, case by case.
- **The server log in the three runs' window** (15:30:39–15:41:50 UTC) holds exactly 3 level-50 lines. Each is `v1: unhandled error | duplicate key value violates unique constraint "entrant_members_pkey"`, one per run: the mexicano red. It is the W7 self-pair 500 that the L3 run records on 30 cases.

### Parity (Step 6)

**The brief's command** compares `../w1drv-http-slice` with `w1drv-l1-r1`. It wrote [`parity.md`](parity.md) and exited 1: `NOT PARITY: compared 0 cases — the two runs share no case`.

- The slice holds league/knockout/swiss on generic and badminton. The L1 set holds five capability cells and two template cells.
- **The pairing is structurally vacuous.** The brief's premise that they share cells is false.

**The comparison that has shared cases** is the ruling-48 L3 run against `w1drv-l1-t15-r1`, written to [`parity-l3-vs-l1.md`](parity-l3-vs-l1.md). It compared **6 cases and 126 common checks**, and exited 1 with 12 differences:

- **0 state differences and 0 verdict differences.**
- **11 differences are `checked` counts only**, every one `pass` on both sides, all on `group_group_ko|cricket|t20`. They are D11 at work:
  - the HTTP case seeds `DEFAULT_FIELD` 8 through the API and plays 19 fixtures;
  - the browser case builds from the t20-super8 card, whose `entrantCount` is 16, and plays 39 fixtures (4×6 + 2×6 + 3).
  - **Not a driver divergence.**
- **1 case is absent on the HTTP side.** `group_only|badminton|short` is the box-league template's own variant, and the L3 plan runs `group_only|badminton` on `bwf`. This is by design.
- **Repeat.** The same comparison against T13's `w1drv-l1-r1` gives the identical 12 differences.

### Observations (a)–(f): T15 re-checked each on t15-r1's screens

| | observation | at the T15 head | triage |
|---|---|---|---|
| (a) | The box-league public page crowns one champion over four boxes | **Reproduced.** `11-public` shows CHAMPION "Matrix Player 1", the Pool A winner, above Boxes Pool A–D. | **Product, a rulebook question → W5.** Should a box league with parallel boxes name a single champion? The owner decides. |
| (b) | Ladder standings read 0 everywhere | **Reproduced.** `11-public` shows P / W / L / PTS 0 on all 8 rungs, with CHAMPION "Matrix Player 2". The division's own Standings tab says "No table stages in this division — standings apply to league, group and swiss stages." | **Product → W7** (ladder family). The L3 ladder R4 note asks a rulebook question about rung ranks. |
| (c) | Americano personal points 0; pair champions | **Reproduced.** In `08-completed` the Rotation "Personal points" table reads PTS 0 for all 8 players at GAMES 7, while the rounds show "✓ scored". `11-public` shows CHAMPION "Matrix Player 4 / Matrix Player 1" over 21 pair rows. The mexicano CHAMPION is "Matrix Player 7 / Matrix Player 4". | **Product → W7.** It matches the L3 finding: the Americano view's "Personal points" are 0 on every sport but generic, and 0 of 14 decided non-generic fixtures carry a `match_states` score. The T12-R1 note, minted pairs as entrants, is confirmed. |
| (d) | No shot of the groups_ko knockout's completion | **Reproduced.** `08-completed` is the group stage's "Stage completed." with the knockout's "Confirm proposal" pending. `11-public` shows the final played. | **Harness screen-coverage gap, owed to T16.** No check misreads it, and the knockout's completion is proven by the case's own checks. |
| (e) | Team entrants are named "Matrix Player N" | **Reproduced** on case-1's `03-entrants`: kind Team, names "Matrix Player 1–8". | **Harness naming, owed to T16.** It breaks the "Matrix Team N" constraint, and no check depends on it. It is outside T15's fix scope, which covers harness defects behind triaged reds. |
| (f) | Duplicate shot grouping varies between runs | In all three T15 runs, case-5 has 17 distinct shots against 16 in T13's r1 and r3: `05-generated-before` equals `08-completed-before`. Case-4 has 16. Every T15 run gives the same counts, 29 / 16 / 16 / 16 / 17 / 18 / 14. | **Timing, not state.** Verdicts and counts are identical. |

**Filler counts** (T13's concern) are still not in `results.json`: `filler` appears 0 times. The live proof stays indirect, and the counts are proven only by unit tests. Recording them is a harness change, owed to T16.

## Evidence

- `w1drv-l1-r1/`, `w1drv-l1-r2/`, `w1drv-l1-r3/` (T13) and `w1drv-l1-t15-r1/`, `w1drv-l1-t15-r2/`, `w1drv-l1-t15-r3/` (T15) hold each run's redacted `results.json` and `MATRIX.md`.
- The shots are kept locally, in the gitignored `matrix-report/<run-id>/shots/`.
- [`parity.md`](parity.md) is the brief's slice-vs-L1 comparison: 0 cases. [`parity-l3-vs-l1.md`](parity-l3-vs-l1.md) is L3 vs L1 over the 6 shared cases.
