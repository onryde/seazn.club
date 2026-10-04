# W2 coverage audit: engine rule possibilities vs the W2 plan

- **Date:** 2026-09-30. **Tree:** `feat/format-matrix-w1c` worktree. Read only, nothing driven. Per AGENTS.md class 5, every "engine does X" below comes from reading the code, not from running it.
- **Question:** is every rule-level possibility the engine declares, for all 11 sports, either a W2 rulebook row or a named gap in the W2 plan?
- **Plan sources:** `W2-scoring-fidelity.md` (the prompt), `rulebook-W2-sets-cricket.md` (row IDs BD/TT/VB/TN/CR, owner items RB2A-n, edge table M/F/X/C), and `rulebook-W2-goals-boards.md` (row IDs F/H/I/B/C/G, owner items RB2B-n).
- **Generator source:** `tools/matrix/lib/streams/*.ts`. The pads replay these streams, and `HARNESS_SCENARIO` (`scenario-catalogue.ts:188`) drives only LIFECYCLE, M1, R4 and F1.
- **Sport list (confirmed):** `SPORT_KEYS = builtinModules.map(m => m.key)` (`tools/matrix/lib/catalogue.ts:37`). `builtinModules` (`packages/engine/src/sports/index.ts:23-35`) holds exactly 11 modules: football, cricket, boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis, icehockey, hockey.

## Legend

- **W2 column:** a row ID or owner-item ID is covered. **text §x** means the rule is stated in the rulebook's prose or tables but has no verdict row. **PARTIAL** means the knobs are covered but the named behaviour is not. **ABSENT** means the term does not appear in either rulebook or the W2 prompt (each checked with `grep -ai` on the sport's section).
- **Gen column (what W1 emits today):**
  - **yes**: the stream reaches the rule path.
  - **cfg**: the matrix varies the config value (the preset, or a `SPORT_RULES` level), but no stream ever reaches the rule path.
  - **pre**: reached only as a forfeit or abandon sent straight after `core.start`, with no play before it.
  - **no**: the stream never reaches the rule path.
- **Kind column:** **R** is result-level (it changes the winner, the score, the table points or the ledger). **M** is an in-match mechanic that does not change the result; these are listed for completeness and are not counted in the ABSENT totals.

### Generator reach, all sports (applies to every table below)

- **Outcomes requested** (`streams/types.ts:13-20`): win-home, win-away, draw, forfeit-walkover, forfeit-"retired hurt", abandon.
- **Forfeit and abandon** are `[core.start, core.forfeit|core.abandon]` (`streams/index.ts:35-38`). So a retirement is never a partial-score retirement, and every abandon is at 0–0.
- **Draws** are sent only where `supportsDraws` is true (`streams/index.ts:39-41`).
- **Decided streams:**
  - Set sports: straight sets, loser at target−winBy−3 (`setbased.ts`).
  - Tennis: straight sets at gamesTo–(gamesTo−winBy−1) (`tennis.ts`).
  - Cricket: one innings a side, win by runs or by wickets (`cricket.ts`).
  - Football: 1–0 or 0–0 in regulation (`football.ts`).
  - Hockey and ice hockey: 1–0 or 0–0 (`period.ts`).
  - Generic: 3–1 or 2–2 (`generic.ts`).
  - Boardgame: checkmate or agreement (`boardgame.ts`).
  - Carrom: board summaries, no queen (`carrom.ts`).
- **Never emitted in any sport:** any decider (extra time, shoot-out, overtime, GWS, super over, DLS), a tie, a deciding set (only when bestOf=1), a set cap, a tie-break set, a double walkover, `abandonPolicy: "award"`, a sanction, or two-innings cricket wins or draws (`known-unsupported.ts`).

---

## Badminton — rulebook §3 (sets-cricket)

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `bwf` | `setbased/badminton.ts:40` | R | BD-1, BD-2 | cfg (straight sets) |
| 2 | Variant `short` (11, cap 15) | `setbased/badminton.ts:42` | R | text §3.2 legal-score table (line 131) | cfg |
| 3 | bestOf must be odd | `setbased/kernel.ts:110,128` | R | BD-2 | yes |
| 4 | setTo / finalSetTo (deciding set target) | `setbased/kernel.ts:111-112,447-449` | R | BD-1 | yes (finalSetTo only at bestOf=1) |
| 5 | winBy (deuce) | `setbased/kernel.ts:113` | R | BD-1 | cfg |
| 6 | cap / golden point (30–29) | `setbased/kernel.ts:114,454-489`; `badminton.ts:26` | R | BD-1 | no |
| 7 | Strict reachable-score check on `game.summary` | `setbased/kernel.ts:719-736` | R | BD-4 | yes (legal scores only) |
| 8 | pointsMap table points (`W-L`, else `*`) | `setbased/kernel.ts:115,2252-2258` | R | BD-6 | yes (`*` only) |
| 9 | No draws | `setbased/kernel.ts:2469-2471` | R | BD-5 | yes (draw refused) |
| 10 | Walkover → `award`, clean-sweep points, 0 games credited | `setbased/kernel.ts:804-814,2451-2458` | R | BD-11 | pre |
| 11 | Retirement: same `core.forfeit`, completed games stand | `setbased/kernel.ts:804-814` | R | BD-10, BD-13 | pre (never partial) |
| 12 | Abandon → no outcome, `replayFlagged` | `setbased/kernel.ts:818-823` | R | §3.3 + RB2A-29 (NEW-H1) | pre |
| 13 | Double walkover | none (`core/events.ts:52` single `by`) | R | BD-14 | no |
| 14 | Sanction ladder (warning/penalty/expulsion/disqualification) is **record-only**: no point awarded, and a DQ does not end the match | `badminton.ts:64`; `setbased/kernel.ts:757-764` | R | **ABSENT** (M10 gives the expected outcome, not the seam) | no |
| 15 | Serve rules (rally-winner serves) | `badminton.ts` `serve:` | M | ABSENT | no |

## Table tennis — rulebook §4

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `bo5` | `setbased/tabletennis.ts:40` | R | TT-2 | cfg |
| 2 | Variant `bo7` | `setbased/tabletennis.ts:41` | R | TT-2 | cfg |
| 3 | Variant `hardbat-21` | `setbased/tabletennis.ts:42` | R | text §4.2 legal-score table (line 208) | cfg |
| 4 | Game to 11, win by 2, uncapped | `tabletennis.ts:24-29` | R | TT-1 | yes (deuce: no) |
| 5 | Expedite (`records.expedite`; the receiver wins on the 13th return) | `tabletennis.ts:37`; `setbased/kernel.ts:559-590,787-799` | R | TT-3 | no |
| 6 | pointsMap 2/0 (ITTF: 2/1/0) | `tabletennis.ts:30` | R | TT-5, RB2A-7 | yes |
| 7 | No draws | `setbased/kernel.ts:2469` | R | TT-4 | yes |
| 8 | Walkover credit | `setbased/kernel.ts:2451-2458` | R | TT-10 | pre |
| 9 | Retirement with played points | `setbased/kernel.ts:804` | R | TT-11 | pre |
| 10 | Defaulted after completion | none | R | TT-12 | no |
| 11 | Abandon → replayFlagged | `setbased/kernel.ts:818-823` | R | RB2A-29 | pre |
| 12 | Double walkover | none | R | TT-14 | no |
| 13 | Sanction warning/penalty is **record-only** (the ITTF penalty point is not awarded) | `tabletennis.ts:67`; `setbased/kernel.ts:757-764` | R | **ABSENT** | no |
| 14 | Timeouts (one per player per match) | `tabletennis.ts:37` | M | ABSENT | no |

## Volleyball — rulebook §5

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `indoor` (25 / fifth set 15, Bo5) | `setbased/volleyball.ts:45`, `:32-38` | R | VB-1, VB-2, VB-3 | cfg (fifth set never reached) |
| 2 | Variant `beach` (21/15, Bo3, 2/0) | `volleyball.ts:57-63` | R | VB-4 | cfg |
| 3 | FIVB pointsMap 3-2 → 2/1, `*` → 3/0 | `volleyball.ts:11` | R | VB-5 | no (3–2 never emitted) |
| 4 | Forfeit clean-sweep 3/0 | `setbased/kernel.ts:2247-2249` | R | VB-6 | pre |
| 5 | Default credit 0–3, 0–25 ×3 | `setbased/kernel.ts:2260-2265` | R | VB-7 | pre |
| 6 | Incomplete team (6.4.3) | `setbased/kernel.ts:804` | R | VB-8 | pre |
| 7 | Bo3 indoor `*` pays 3/0 for a 2–1 | `setbased/kernel.ts:2252-2256` | R | VB-12, RB2A-10 | cfg (2–1 never emitted) |
| 8 | No draws | `setbased/kernel.ts:2469` | R | VB-14 | yes |
| 9 | Abandon → replayFlagged | `setbased/kernel.ts:818-823` | R | RB2A-29 | pre |
| 10 | Double default | none | R | VB-13 | no |
| 11 | Wins-before-points cascade | `volleyball.ts:97` | R | VB-9, VB-11 | default only |
| 12 | Sanction ladder incl. penalty, expulsion and DQ is **record-only** (no point to the opponent, no incomplete-team ending) | `volleyball.ts:102`; `setbased/kernel.ts:757-764` | R | **ABSENT** | no |
| 13 | Technical timeouts, substitutions, libero | `setbased/kernel.ts:235`; `volleyball.ts:42` | M | ABSENT | no |

## Tennis — rulebook §6

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `tour` | `tennis/tennis.ts:28` | R | TN-8 | cfg |
| 2 | Variant `grand-slam` (Bo5, final-set TB to 10) | `tennis.ts:32` | R | TN-13 | cfg (final set never reached) |
| 3 | Variant `fast4` (4 games, TB at 3–3 to 5, No-Ad) | `tennis.ts:34-38` | R | TN-9, TN-10, RB2A-12 | cfg |
| 4 | Variant `doubles-noad-mtb10` | `tennis.ts:40-43` | R | TN-2, TN-11 | cfg (MTB never at Bo3) |
| 5 | Deuce / advantage game | `nested/kernel.ts:985-1003` | R | TN-1 | no (set summaries only) |
| 6 | No-Ad deciding point | `nested/kernel.ts:994` | R | TN-2 | cfg |
| 7 | Tie-break to 7 at 6–all; TB serve order | `nested/kernel.ts:865-871,969-977,1005-1044` | R | TN-3, TN-4, TN-6 | no |
| 8 | Advantage set (`tiebreakAt: null`) | `nested/kernel.ts:72,197` | R | TN-5 | cfg |
| 9 | `tiebreak.winBy` shared by TB and MTB | `nested/kernel.ts:184` | R | TN-10 | cfg |
| 10 | MTB replaces the final set | `nested/kernel.ts:179,850-861` | R | TN-11 | yes (bestOf=1 only) |
| 11 | Bo1 + MTB | `nested/kernel.ts:850-853` | R | TN-12, RB2A-13 | yes |
| 12 | Legal TB-set scores (7–6 / 7–5) | `nested/kernel.ts:1360-1367` | R | TN-7 | no |
| 13 | Table points win/loss | `tennis.ts:25`; `nested/kernel.ts:2197-2218` | R | §2 shared-facts row | yes |
| 14 | A won MTB counts 0 games | `nested/kernel.ts:2039-2050` | R | TN-16 | yes (Bo1) |
| 15 | Retirement / default credit | `nested/kernel.ts:1375-1386` | R | TN-15 | pre |
| 16 | Abandon | `nested/kernel.ts:1387-1392` | R | RB2A-29 | pre |
| 17 | Double walkover | none | R | TN-17 | no |
| 18 | No draws | `nested/kernel.ts:2223-2225` | R | TN-18 | yes |
| 19 | Sanction `point_penalty` / `game_penalty` / **`default`** is **record-only**: a `default` does not end the match | `nested/kernel.ts:256-261,1089-1097` | R | **ABSENT** (§6.3 names the "conduct default" outcome, not the seam) | no |
| 20 | `tennis.game.award` (penalty game) | `nested/kernel.ts:350,1239` | R | **ABSENT** | no |
| 21 | Interruptions (medical/toilet/heat/other; count and seconds are flagged, never refused) | `nested/kernel.ts:96-145,192` | M | ABSENT | no |

## Cricket — rulebook §7

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `t20` | `cricket/cricket.ts:3551` | R | CR-1..CR-13 | yes |
| 2 | Variant `odi` (minimum 20 overs for a result) | `cricket.ts:3552-3557` | R | PARTIAL (C3 "not opened"; CR-13 is T20's 5 overs; §7.5 names the knob) | cfg |
| 3 | Variant `hundred` (5-ball overs) | `cricket.ts:3558` | R | RB2A-26 | yes |
| 4 | Variant `test` (two innings, draw) | `cricket.ts:3559-3567` | R | CR-19 | pre only (wins and draws are KNOWN_UNSUPPORTED) |
| 5 | Points win/tie/NR/loss | `cricket.ts:53-61` | R | CR-1, RB2A-24 | yes (win, NR) |
| 6 | `points.draw` (two innings) | `cricket.ts:59,3562` | R | **ABSENT** (the §7.3 table has no Draw row) | pre (test abandon → draw) |
| 7 | `superOver` on a tie | `cricket.ts:62,935-946` | R | CR-11, RB2A-18 | cfg |
| 8 | `superOverStillTied` repeat / boundary_count / shared | `cricket.ts:66,1870-1882` | R | CR-11; boundary_count named (§7.6 note, SC-C6); §7.5 "still-tied policy" | no |
| 9 | Super-over batting order | `cricket.ts:1754-1760` | R | CR-12 | no |
| 10 | Abandon **during** a super over → `tie` | `cricket.ts:1146-1148` | R | PARTIAL (text §7.2 "if impossible, tied"; no CR row) | no |
| 11 | DLS target and par (standard edition) | `cricket.ts:67-69`; `dls.ts:153,165` | R | CR-15 | cfg |
| 12 | DLS result at abandonment | `cricket.ts:1150-1177` | R | CR-8, RB2A-20 | no |
| 13 | DLS par level → `tie` | `cricket.ts:1172-1175` | R | text §7.2 | no |
| 14 | Manual (non-DLS) revised target/overs (`targetSource: "manual"`) | `cricket.ts:259-266,553,1070-1137` | R | PARTIAL (CR-9 covers only a DLS-applied target) | no |
| 15 | `minOversForResult` | `cricket.ts:73,1152-1161` | R | CR-13, CR-14 | pre (NR) |
| 16 | Abandon → `no_result` | `cricket.ts:1179` | R | CR-2, RB2A-19 | pre |
| 17 | Two-innings abandon → `draw` | `cricket.ts:1143-1145` | R | PARTIAL (only the generic RB2A-19/ST-G1) | pre (test) |
| 18 | Forfeit → `award`; NRR charge | `cricket.ts:3776-3783,3916-3921` | R | CR-10, RB2A-21 | pre |
| 19 | Tie outcome | `cricket.ts:945` | R | CR-11 | no |
| 20 | Knockout tie / NR progression; joint winners | `append-event.ts:334-346` | R | CR-16, CR-17, RB2A-17 | pre (NR) |
| 21 | Win by runs / wickets margins | `cricket.ts:960-984` | R | text §7.2 (implicit) | yes |
| 22 | Innings victory (`innings_and_runs` margin) | `cricket.ts:535,995` | R | **ABSENT** | no |
| 23 | Follow-on (cfg + event, lead check) | `cricket.ts:70-72,3755-3770` | R | **ABSENT** (0 hits) | no |
| 24 | Declaration (`cricket.innings.declare`) | `cricket.ts:244,410` | R | text §7.2 | no |
| 25 | Two-innings `cricket.match.close` → draw | `cricket.ts:254,3736-3743` | R | CR-19 | no |
| 26 | Innings forfeiture (`innings.close` reason `forfeited`, Law 15) | `cricket.ts:251` | R | **ABSENT** | no |
| 27 | All out = playersPerSide−1 | `cricket.ts:51` | R | CR-5, text §7.2 | yes (at playersPerSide=3) |
| 28 | NRR ledger, super over excluded, NR zeroed | `cricket.ts:3849-3943` | R | CR-4..CR-7, CR-20 | yes |
| 29 | Chase overshoot | `cricket.ts:1661-1692` | R | CR-18, RB2A-22 | no |
| 30 | Timeless innings (`ballsPerInnings: null`): NRR quota undefined | `cricket.ts:49` | R | **ABSENT** | no |
| 31 | Penalty runs (`extras.kind: "penalty"`) | `cricket.ts:146` | R | **ABSENT** | no |
| 32 | `supportsDraws` two innings, table stages only | `cricket.ts:3964-3966` | R | CR-19 | yes |
| 33 | Coarse `innings.summary` | `cricket.ts:231-237` | R | §2 shared facts | yes |
| 34 | Batter retire (hurt/out) | `cricket.ts:275-281` | M | ABSENT | no |
| 35 | DRS reviews allowance | `cricket.ts:78,294-300` | M | ABSENT | no |
| 36 | maxOversPerBowler | `cricket.ts:52` | M | ABSENT | cfg |
| 37 | Powerplay, free hit, new ball, toss | `cricket.ts:287,189,283,240` | M | ABSENT | no |
| 38 | Wicket modes (timed out, obstructed, hit twice…) | `cricket.ts:151-162` | M | ABSENT | no |
| 39 | lineupChanges / concussion replacements | `cricket.ts:90` | M | ABSENT | no |

## Football — goals-boards §1

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `11-a-side` | `football/football.ts:2448` | R | F-1 | yes |
| 2 | Variant `youth` (30-min halves) | `football.ts:2449` | R | PARTIAL (§1.6 "youth 3" attempts; F-23 lists it) | cfg |
| 3 | Variant `small-sided` | `football.ts:2450` | R | F-23 | cfg |
| 4 | Variant `mini-soccer` (4 quarters) | `football.ts:2451` | R | F-1 | cfg |
| 5 | halfMinutes / halves | `football.ts:74`, `halves` | R | F-1 | yes |
| 6 | Extra time | `football.ts:104-108,999-1023` | R | F-2, F-6 | cfg |
| 7 | Shoot-out (5 then sudden death; order) | `football.ts:110`; `period/shootout.ts:60-85` | R | F-3, F-4, F-26, RB2B-38 | cfg |
| 8 | Points 3/1/0 | `football.ts:111-121` | R | F-8 | yes |
| 9 | Group shoot-out split shootoutWin/Loss | `football.ts:111-121,2622-2636` | R | F-9, RB2B-7 | cfg |
| 10 | Walkover `awardScore` 3–0 | `football.ts:122,1635-1651` | R | F-15 | pre |
| 11 | Pitch score kept if worse for the offender | `football.ts:1640-1644` | R | F-16 | no |
| 12 | abandonPolicy `replay` | `football.ts:173,1653-1661` | R | F-17 | pre |
| 13 | abandonPolicy `award` (level → no_result) | `football.ts:173` | R | F-18, F-19 | no (not a SPORT_RULES field) |
| 14 | Draws only in table stages | `football.ts:2666-2667` | R | §1.5 | yes |
| 15 | Level KO with no decider → DRAW_NOT_ALLOWED | `append-event.ts:334-346` | R | F-7, RB2B-1 | no |
| 16 | Fair-play card values | `football.ts:123,1036-1057` | R | F-11 | no |
| 17 | Tiebreak presets fifa2026 / classic | `football.ts:1704-1710` | R | F-10, F-12, F-13, RB2B-4 | default only |
| 18 | **Own goal credits the opponent** | `football.ts:219,1101` | R | **ABSENT** | no |
| 19 | Win method `shootout` / extra time; kicks not goals | `football.ts:1630,1685-1697` | R | F-5 | no |
| 20 | Double walkover | none | R | F-20, RB2B-15 | no |
| 21 | Retirement / reduced below 7 | `core.forfeit` | R | §1.3, M3 | pre |
| 22 | teamSize | `football.ts` `teamSize` | R | §1.6 row | cfg |
| 23 | Sin bin (`sinBinMinutes`) | `football.ts:152,360-380` | M | ABSENT | cfg |
| 24 | In-play penalty kick record | `football.ts:220,327,1418` | M | ABSENT | no |
| 25 | Subs: rolling / max / concussion / windows | `football.ts` cfg | M | ABSENT | cfg |
| 26 | periodSeconds / addedMinutes | `football.ts` cfg, `:265-270` | M | ABSENT | no |

## Hockey (FIH) — goals-boards §2

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `fih-outdoor` | `hockey/hockey.ts:138` | R | H-1 | yes |
| 2 | Variant `fih-shootout` (SO 5 / SD / 8 s; 2/1) | `hockey.ts:141-144` | R | H-8 | cfg |
| 3 | Variant `youth` (4×10, 7-a-side, youth suspensions) | `hockey.ts:161-165` | R | PARTIAL (§2.6 settings "youth 7", "youth 3") | cfg |
| 4 | 4 quarters; goal kinds fg/pc/stroke/og | `hockey.ts:125-136` | R | H-1 | yes |
| 5 | Draws, 3/1/0 | `hockey.ts:129`; `period/kernel.ts:2644-2647` | R | H-2 | yes |
| 6 | Level → SO only when declared | `period/kernel.ts:1029-1041` | R | H-3, H-10 | cfg |
| 7 | SO attempts / suddenDeath / order | `period/kernel.ts:192-195`; `shootout.ts` | R | H-4, H-5, H-20 | no |
| 8 | SO goals not in GF | `period/kernel.ts` | R | H-6 | no |
| 9 | SO league split (win 1 / lost 1) | `period/kernel.ts:2614-2622` | R | H-7 | no |
| 10 | Walkover `awardScore` 3 | `hockey.ts:134`; `period/kernel.ts:1429-1444` | R | H-13, H-14, RB2B-6 | pre |
| 11 | Abandon replay / award | `hockey.ts:135`; `period/kernel.ts:1446-1463` | R | H-15, H-16, RB2B-13 | pre (replay only) |
| 12 | Cascade | `hockey.ts:212` | R | H-11, H-12, RB2B-11 | default only |
| 13 | Double walkover | none | R | H-17 | no |
| 14 | Deciders per stage, match format per fixture | stage-cfg | R | H-9, H-18, H-19 | no |
| 15 | **Team reduced below `strength.min`** (11/7) has no ending rule; `strengthChip` is display only | `hockey.ts:131`; `period/kernel.ts:2323` | R | **ABSENT** (football has M3; hockey has none) | no |
| 16 | Result-only entry / settle event | none | R | H-21, H-22 | no |
| 17 | Suspension classes green/yellow/red | `period/suspensions.ts`; `hockey.ts:130` | M | ABSENT | no |
| 18 | Goalkeeper required/optional; PC/stroke set pieces | `period/kernel.ts:160,391` | M | ABSENT | no |

## Ice hockey (IIHF) — goals-boards §3

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `iihf` | `icehockey/icehockey.ts:179` | R | I-1 | yes |
| 2 | Variant `recreational` (no OT, draws, 2/1/0) | `icehockey.ts:196-201` | R | I-14 | yes |
| 3 | OT sudden death 5 min 3-on-3 | `icehockey.ts:167`; `period/kernel.ts:1134` | R | I-2 | cfg |
| 4 | OT kind `periods` (count × minutes) | `period/kernel.ts:183-185` | R | I-11, RB2B-9 | no |
| 5 | GWS 5, then tie-break shots; order | `icehockey.ts:168` | R | I-3, I-4, RB2B-10 | no |
| 6 | Shoot-out winner credited one goal | `icehockey.ts:245` | R | I-5 | no |
| 7 | Points 3-2-1-0 (otWin/otLoss) and columns | `icehockey.ts:170` | R | I-6, I-7, I-13, RB2B-8 | no |
| 8 | Walkover `awardScore` 5 | `icehockey.ts:175` | R | I-15, I-16 | pre |
| 9 | Abandon replay / award | `icehockey.ts:176` | R | I-17, I-18 | pre (replay) |
| 10 | Cascade and H2H re-application | `icehockey.ts:237` | R | I-8, I-9, I-10, RB2B-12 | default only |
| 11 | Double walkover | none | R | I-19 | no |
| 12 | Draws only with OT and SO off, table stages | `period/kernel.ts:2644-2647` | R | I-14 | yes (at the OT-off, SO-off levels) |
| 13 | Goal kinds pp/sh/ps/og | `icehockey.ts:173` | R | I-1 | no |
| 14 | Per-stage deciders / format | stage-cfg | R | I-12, I-20, I-21 | no |
| 15 | Suspensions minor/major/misconduct; `releaseOnGoal` power play | `icehockey.ts:171`; `period/kernel.ts:131-137,977` | M | ABSENT | no |
| 16 | Strength 5/3 skaters | `icehockey.ts:172` | M | ABSENT | no |

## Boardgame — goals-boards §4

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variants classical / rapid / blitz (clock family) | `boardgame/boardgame.ts:579-584` | R | header + B-15 | cfg |
| 2 | Scoring 2/1/0 half-points | `boardgame.ts:40-48` | R | B-1, B-2, B-14, RB2B-17, RB2B-18 | yes |
| 3 | Colours and colour history | `boardgame.ts:48,320-335` | R | B-8 | yes |
| 4 | `byeScore` | `boardgame.ts:52` | R | routed to W3 (§4 "Bye value — W3") | no |
| 5 | Clock base / increment / delay | `boardgame.ts:60-85` | R | B-15 | cfg |
| 6 | Decisive methods (checkmate, resign, time, forfeit, adjudication, illegal_move) | `boardgame.ts:104-118,392` | R | B-11, RB2B-20 | yes (checkmate only) |
| 7 | Drawn methods (agreement, stalemate, insufficient, repetition, fifty_move, dead_position) | `boardgame.ts:394-395` | R | B-11, text §4.1 | yes (agreement only) |
| 8 | Forfeit (live only) | `boardgame.ts:616-629` | R | B-6, B-7, RB2B-21 | pre |
| 9 | `double_forfeit` → no_result | `boardgame.ts:264-266` | R | B-9, B-10 | no |
| 10 | Abandon → `abandoned` + replayFlagged | `boardgame.ts:631-635` | R | PARTIAL (text §4.1/§4.3 "replay; nothing counts"; no B row) | pre |
| 11 | Draws allowed in every stage incl. KO | `boardgame.ts:770-772` | R | B-3, B-4, RB2B-16 | yes (KO draw emitted) |
| 12 | Tiebreak cascade | `boardgame.ts:350-358` | R | B-12, B-13, B-16, RB2B-19 | default only |
| 13 | Pairing card (white, board) | `boardgame.ts:166-178` | R | B-8, B-17 | no |

## Carrom — goals-boards §5

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `icf` | `carrom/carrom.ts:821` | R | C-1 | yes |
| 2 | Variant `club-29` (29 / queen 5 / cap 24) | `carrom.ts:822` | R | PARTIAL (not named; the knobs appear in §5.6) | cfg |
| 3 | gameTo / maxBoards | `carrom.ts:53-54,304-314` | R | C-1 | yes |
| 4 | bestOf odd | `carrom.ts:55,72` | R | C-2, C-12 | yes |
| 5 | queenPoints / queenCapAt | `carrom.ts:56-61,395` | R | C-3 | cfg (queen never pocketed) |
| 6 | pointsPerCoin | `carrom.ts:62` | R | C-3 | yes |
| 7 | queenFollowsBoard | `carrom.ts:66,390-392` | R | §5.6 row | cfg |
| 8 | tieBoard `extra` / `draw` | `carrom.ts:69,312` | R | C-1, C-4, RB2B-23 | no (draw unsupported) |
| 9 | Drawn games inside a match; match won on games after bestOf (e.g. 1–0 + a draw) | `carrom.ts:343-346` | R | PARTIAL (§5.2 mentions only a drawn match) | no |
| 10 | Points 2/1/0 | `carrom.ts:45-49` | R | C-5, RB2B-27 | yes |
| 11 | Game adjust (due / foul / other) | `carrom.ts:116-135` | R | C-11, RB2B-26 | no |
| 12 | Walkover | `carrom.ts:451-462` | R | C-6, RB2B-24 | pre |
| 13 | Abandon → no_result | `carrom.ts:465-470` | R | C-7, RB2B-25 | pre |
| 14 | Double walkover | none | R | C-8 | no |
| 15 | supportsDraws only with tieBoard draw, table stages | `carrom.ts:983-988` | R | C-4 | no |
| 16 | Toss / first break | `carrom.ts:88` | M | text §5.1 | no |

## Generic — goals-boards §6

| # | Possibility | Engine file:line | Kind | W2 | Gen |
|---|---|---|---|---|---|
| 1 | Variant `win_loss` | `generic/generic.ts:510-515` | R | G-1 | yes |
| 2 | Variant `score` | `generic.ts:516-521` | R | G-1 | yes |
| 3 | allowDraws; knockout deny-list | `generic.ts:32,650-654` | R | G-2, G-3, RB2B-28 | yes (page_playoff/ladder draws emitted) |
| 4 | Points w/d/l | `generic.ts:36-43` | R | G-4 | yes |
| 5 | **`progressScore`** (stepladder carry, stored, **no effect in the module**) | `generic.ts:45` | R | **ABSENT** (no hit in any rulebook or W-prompt) | no |
| 6 | Running tally `generic.score`, negative corrections | `generic.ts:64-73` | R | text §6.2, G-8 | no |
| 7 | Result card settles from the tally | `generic.ts:116-117` | R | text §6.2 | no |
| 8 | Forfeit | `generic.ts:557-564` | R | G-5, RB2B-29 | pre |
| 9 | Abandon → no_result | `generic.ts:565-570` | R | G-6, RB2B-25 | pre |
| 10 | Double walkover | none | R | G-7 | no |
| 11 | Score cap 500 (pad only) | `generic.ts:250` | R | G-8 | no |

## Cross-sport core events

| Possibility | Engine | W2 | Gen |
|---|---|---|---|
| `core.suspend` / `core.resume` (resume from saved score) | `core/events.ts:76-98` | sets-cricket §8 X1/X4 only; goals-boards has no row | no |
| `core.void`, correction, finalize | `core/events.ts:100-105` | M7, M8 (both rulebooks) | no |
| `award.method` carries the reason (walkover vs retirement vs DQ) | `core/types.ts:127-137` | BD-13, SC-S4 | pre |

---

## Sports with no rulebook section

**None.** All 11 sports have a section:
- sets-cricket: badminton §3, table tennis §4, volleyball §5, tennis §6, cricket §7.
- goals-boards: football §1, hockey §2, ice hockey §3, boardgame §4, carrom §5, generic §6.

The thinnest sections are generic (G-1..10) and carrom (C-1..13).

## Counts (R = result-level; M = in-match, not counted as ABSENT)

| Sport | R found | ABSENT (R) | PARTIAL | M found (all ABSENT unless noted) |
|---|---|---|---|---|
| badminton | 14 | 1 | 0 | 1 |
| tabletennis | 13 | 1 | 0 | 1 |
| volleyball | 12 | 1 | 0 | 1 |
| tennis | 20 | 2 | 0 | 1 |
| cricket | 33 | 6 | 4 | 6 |
| football | 22 | 1 | 1 | 4 |
| hockey | 16 | 1 | 1 | 2 |
| icehockey | 14 | 0 | 0 | 2 |
| boardgame | 13 | 0 | 1 | 0 |
| carrom | 15 | 0 | 2 | 1 (covered by text §5.1) |
| generic | 11 | 1 | 0 | 0 |
| **total** | **183** | **14** | **9** | 19 |

## ABSENT from W2 (result-level)

| Sport | Possibility | Engine file:line |
|---|---|---|
| badminton | Sanction ladder is record-only: a penalty awards no rally and a DQ does not end the match | `setbased/badminton.ts:64`; `setbased/kernel.ts:757-764` |
| tabletennis | Sanction penalty point is not awarded (record-only) | `setbased/tabletennis.ts:67`; `setbased/kernel.ts:757-764` |
| volleyball | Sanction penalty, expulsion and DQ are record-only (no point, no incomplete-team ending) | `setbased/volleyball.ts:102`; `setbased/kernel.ts:757-764` |
| tennis | `sanction{level:"default"}` does not end the match; point/game penalty are record-only | `nested/kernel.ts:256-261,1089-1097` |
| tennis | `tennis.game.award` (penalty game) seam | `nested/kernel.ts:350,1239` |
| cricket | `points.draw` for two-innings draws | `cricket/cricket.ts:59,3562` |
| cricket | Innings victory (`innings_and_runs` margin) | `cricket.ts:535,995` |
| cricket | Follow-on (cfg, event, lead check) | `cricket.ts:70-72,3755-3770` |
| cricket | Innings forfeiture (`innings.close` reason `forfeited`) | `cricket.ts:251` |
| cricket | Timeless innings (`ballsPerInnings: null`): NRR quota / all-out charge | `cricket.ts:49` |
| cricket | Penalty runs (`extras.kind: "penalty"`) | `cricket.ts:146` |
| football | Own goal credits the opponent | `football/football.ts:219,1101` |
| hockey | Team reduced below `strength.min` has no ending rule (display chip only) | `hockey/hockey.ts:131`; `period/kernel.ts:2323` |
| generic | `progressScore` is declared and stored, with no effect (inert seam) | `generic/generic.ts:45` |

**PARTIAL (named only in prose, or only generically):**
- cricket: ODI 20-over minimum; abandon during a super over → tie; manual (non-DLS) revised target; two-innings abandon → draw.
- football: `youth` variant.
- hockey: `youth` variant.
- boardgame: abandon → replayFlagged (no B row).
- carrom: `club-29` variant; drawn games inside a won match.
- Also noted: football two-leg aggregate / away goals. The rulebook cites it in its IFAB Law 10.2 authority row, but there is no engine code and no row. It is format-level, so it is not counted.
