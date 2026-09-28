# Fixture-generation gap audit — every format except Swiss

Repo: /Users/ashokhein/github/seazn.club, `main` @ 782628af5 (2026-09-27). Read-only.
Method: read the generators (`packages/engine/src/scheduling/{roundrobin,bracket,americano}.ts`,
`competition/{progression,stage}.ts`) and the persistence and orchestration layer
(`apps/web/src/server/usecases/stages.ts` generate/rebuild/seed/addFixture/issueChallenge,
`withdrawal.ts`, `scoring.ts onDecided`, `engine-db/{competition,fed-seats}.ts`,
`components/v2/board/round-codes.ts`, `components/v2/format-templates.ts`). I also ran pure-engine
simulations (scratchpad `p1.ts`…`p6.ts`, `node` on the engine's own `.ts`). Nothing was driven
in a browser or against a DB, so every "customer impact" line is reasoned from code plus an engine
run, not observed on screen.

Scoped engine gate: 7 suites (bracket, roundrobin, formats-ext, bracket-layout, stage, progression,
round-role): **144/144 passed** (JSON reporter, `.testResults[].name` confirmed). The suites are green
even though gaps G3, G4, G5 and G8 below are engine-level.

## Supported formats (StageKind, `packages/engine/src/core/types.ts:91-101`)

| Kind | Generator | Notes |
|---|---|---|
| `league` | `generateRoundRobin` (circle method), legs 1–8 (single/double/triple RR) | `stages.ts:1629-1636` |
| `group` | seeded snake into N pools (`snakeDistribute`, `stages.ts:1579`), then RR per pool | pools A–Z |
| `knockout` | `generateSingleElim`: seed fold, byes to top seeds, optional `thirdPlace`, custom `byes`, `slotOrder` | `bracket.ts:120-230` |
| `double_elim` | `generateDoubleElim`: WB + LB + GF, optional `bracketReset` | `bracket.ts:268-367` |
| `page_playoff` | `generatePagePlayoff`: exactly 4 teams, Q1/E/Q2/F | `bracket.ts:381-393` |
| `stepladder` | `generateStepladder`: any k ≥ 2, E1…F | `bracket.ts:405-432` |
| `americano` | `generateAmericano` (all rounds up front) / `pairMexicanoRound` (one round per Generate) | `americano.ts`; `stages.ts:734-829` |
| `ladder` | no bulk generation; fixtures come from `issueChallenge` | `stages.ts:5503` |
| `swiss` | excluded here (another agent covers Swiss) | |

Multi-stage templates (`format-templates.ts`, `server/templates/catalog/*.json`): league_ko, groups_ko,
ko_plate (consolation), qualifying_main, triple_rr, americano, mexicano, ladder, double_elim, euro24,
t20-super8, league-playoff. These link stages through `progression` (`timing: "setup"` placeholder
slots, or `"on_complete"` `config.qualified`).

## Format matrix

Legend: ✅ works as read/run · ⚠️ works with a defect or caveat (see gap ID) · ❌ broken or missing · n/a

| Format | Generate | Byes / odd field | Seeding | Regenerate-safe (roster change) | Void / undo | Walkover advance | Round codes (board) | 3rd place / plate | Tests unit / e2e |
|---|---|---|---|---|---|---|---|---|---|
| league (1–8 legs) | ✅ `roundrobin.ts:95-164`; home/away \|h−a\|≤1 proven | ✅ pivot = bye when odd; ⚠️ bye not persisted (G21) | ✅ seed asc, top seed = pivot; ⚠️ unseeded = registration order (G17) | ❌ **G1** (#879 OPEN) | ✅ recompute standings; ⚠️ after a confirmed proposal (G16) | n/a (expunge policy) | R{n} (by design) | n/a | ✅ roundrobin.test, formats-ext / ✅ many |
| group (pools) | ✅ snake + RR | ✅ | ✅ snake by seed | ❌ G1 (pool-scoped) | ✅ | n/a | ⚠️ R{n}, no pool letter (G19) | n/a | ✅ / ✅ stage-progression |
| groups → knockout | ✅ topNPerGroup wave-major + bestNth, rank_order | ✅ | ⚠️ **G5**: 3 pools → C1 v C2 in R1 | setup-timing: ✅ (topology only) | ⚠️ G16 | ✅ | ✅ QF/SF/F | per template | ⚠️ only 2- and 4-pool cases tested |
| knockout (SE) | ✅ fold 1vN, byes to top seeds | ✅ `award` rows, cascade `resolveBracketSeats` | ✅ protected seeds via fold; custom byes/slotOrder | ❌ **G2** | ✅ #856 un-fill (`fed-seats.ts`) same-stage; ⚠️ cross-stage (G18) | ✅ F14 + dead-feeder cascade | ✅ R16/QF/SF/F/3rd | ✅ `thirdPlace` | ✅ bracket.test, knockout-void-unfill / ✅ knockout, hub-knockout, board-round-codes |
| double_elim | ✅ | ✅ (LB dead-loser feeders via `loserFeederIsDead`) | ✅ WB fold; ❌ LB drop order (**G4**) | ❌ G2 | ✅ un-fill (loser edge too) | ✅ | ✅ WB/LB/GF | reset: ❌ **G3** | ✅ / ⚠️ no e2e plays one to completion |
| page_playoff | ✅ exactly 4 | n/a | ✅ 1v2, 3v4 | ✅ refuses ≠4 (CONFIG_INVALID) | ✅ | ❌ **G7** (withdrawal voids) | ✅ Q1/E/Q2/F | n/a | ⚠️ unit via round-role / e2e only board codes |
| stepladder | ✅ | n/a | ✅ | ❌ G2 (positional `sl-g{j}`) | ✅ | ✅ | ✅ E1…F | n/a | ✅ / e2e board codes only |
| americano | ⚠️ **G8** coverage, **G9** bye fairness | ⚠️ G9 | n/a | ❌ **G12** | ❌ n/a (no drift, no rebuild) | n/a | R{n} | n/a | ⚠️ test title lies (G8) / ✅ formats.spec renders |
| mexicano | ⚠️ **G11** blocks on non-`decided` | ⚠️ G9 | points ⚠️ **G10** | n/a (one round per press) | ⚠️ G11 | n/a | R{n} | n/a | ✅ one unit / ❌ no e2e |
| ladder | ✅ on-demand challenges | n/a | ✅ ladder_order from seed | ❌ **G6** (late joiner never on the ladder) | ✅ | n/a | R{n} | n/a | ✅ ladder-* tests / ✅ ladder-withdrawn-challenge |
| ko_plate (consolation) | ✅ roundLosers | ⚠️ **G14** | rank_order | setup ✅ | — | — | ✅ | ⚠️ G14: plate waits for the main final | ⚠️ |

Other cross-format findings:
- **Per-stage match rules (#804):** merged 2026-09-20. The D7 editor shipped as option A (`7d5433faf`,
  `StageFormatRow` in `stages-panel.tsx:1190`), so the memory note "T7 BLOCKED on D7" is **stale**. It is
  stage-kind agnostic (every kind gets the row) but limited to `STAGE_RULES_SPORTS` =
  tennis/badminton/tabletennis/volleyball (`lib/match-rules.ts:956`). That limit is owner scope D2a, not a
  defect (G23).
- **Round codes:** `CODED_STAGE_KINDS` = knockout, double_elim, page_playoff, stepladder
  (`round-codes.ts:85`). Every bracket kind is coded. League, group, americano and ladder keep `R{n}`,
  and group cards carry no pool (G19).
- **#879 (league Generate duplicates) is OPEN on GitHub and in code.** #840 (Rebuild wipes the schedule,
  and its confirm hides that) is also OPEN.
- **Scheduling hand-off:** generation writes no time or court. Placement is the separate
  build/solver/AI path, with rest floors and feeder rest covered (`rest-floor.ts`,
  `calendar-feeder-rest.test.ts`). Rebuild NULLs every time and court (#840). Additive Generate and
  Add match leave new rows unscheduled with no prompt.

## Gap table

| ID | Format | Gap | Evidence file:line | Sev | Customer impact | Read vs inferred |
|---|---|---|---|---|---|---|
| G1 | league, group | Generate after roster growth reconciles by POSITION key `rr-r{round}-c{court}` and inserts only missing keys, so pairings are duplicated and others never created. There is no warning, and the drift banner clears. The Generate button comment calls this "a routine, safe action". | `roundrobin.ts:140`; `stages.ts:2509`; `desk/stage-rail.tsx:490-512`; issue #879 OPEN | H | An organiser who adds a late player and presses Generate gets some matches twice and some pairs that never play, and nothing on screen says so. | Read + engine sim (3→4: 2 dup / 2 missing; 8→9: 6 dup / 6 missing) |
| G2 | knockout, double_elim, stepladder | The same positional reconcile for brackets. Within the same bracket size (e.g. 6→7) nothing is inserted and "up to date" is shown, so the new entrant is never placed. Crossing a power of two (8→9) adds new round-1 lines holding entrants already seated, while the old final survives beside a new one. | `bracket.ts:185-205` (`se-r{r}-i{i}` ids); `stages.ts:2509` | H | A late entrant added to a knockout is either silently left out of the draw or the bracket fills up with duplicate players. | Read + engine sim (8→9: C,F,G,B seated twice) |
| G3 | double_elim + bracketReset | Nothing voids `gf-reset` when the WB champion wins GF1: both seats fill, so it reads as a real match to play. apps/web marks `gf` not-final (it feeds the reset), so the stage cannot complete until the reset is settled. If the organiser abandons it, `bracketRanks` finds no decided final and ranks the **unbeaten champion LAST**. | `bracket.ts:352-362`; `engine-db/competition.ts:635-639`; `stage.ts:317-323`; grep: no writer voids a `conditional` fixture | H | After the favourite wins the grand final, the app asks for a pointless rematch, and if the organiser cancels it the final table names the champion as last place. | Read + engine run (ranks `L > C > D > W`); DB path inferred |
| G4 | double_elim | Losers-bracket major rounds drop WB round m+1 game i's loser straight onto LB game i, so a player meets someone they just played. If the favourite wins every match, every LB major-round game is an immediate rematch (8 teams: lb-r1 ×2, lb-r3). Standard brackets cross the drop order. | `bracket.ts:303-317` | M | In a double-elimination event, losers-bracket players keep replaying the opponent they just met. | Engine sim (n=8,16,6,12) |
| G5 | groups → knockout | With the wave-major `rank_order` fold, 3 pools top-2 (q=6 or 8) pairs **C1 v C2** in round 1, and 5 pools top-3 pairs A2 v A3. Tests cover only 2 and 4 pools. | `progression.ts:124-131`; `bracket.ts:52-66`; `format-templates.ts:~85-130`; test `format-templates.test.ts:348-380` | M | A 3-group tournament replays group C's top two against each other in the first knockout round. | Engine sim |
| G6 | ladder | `ladder_order` is written once, on the first challenge, and only reordered after that. An entrant registered later is not on it, so any challenge by or against them is refused `LADDER_ENTRANT_FOREIGN`. No code path appends newcomers. | `stages.ts:5539-5560`; `scoring.ts:776-786` (only other writer) | H | A player who joins a running club ladder can never challenge or be challenged. | Read (grep of every `ladder_order` writer) |
| G7 | page_playoff | Withdrawal puts page_playoff in the "open formats: remaining games void" branch, not walkover (`BRACKET_WALKOVER_KINDS` excludes it). The voided line (abandoned, no outcome) is a dead feeder, so the cascade hands walkovers onward. If seed 1 withdraws before Q1, seed 2 is eliminated without playing and the Eliminator winner walks through. | `withdrawal.ts:191-216`; `stages.ts:891-895, 3655-3658` | H | If a top-two team pulls out of an IPL-style playoff, its opponent is knocked out too instead of getting a walkover. | Inferred from read (not run) |
| G8 | americano | The "whist-style" rotation rotates contiguous windows and does not cover partnerships: 8 players → 21/28 partner pairs, 16 → 45/120, some repeated up to 4×. The unit test "rotation covers pairings evenly" only compares counts among pairs that DID occur (max−min ≤ 2), so it cannot see missing ones (AGENTS.md class 4). | `americano.ts:34-62`; `formats-ext.test.ts:44-66` | M | Americano players partner some people twice and never meet others, which is the opposite of what the format promises. | Engine sim |
| G9 | americano / mexicano | Byes always fall on the tail of the rotated order, and the pivot (player 0) never sits out: with 6 players the pivot plays 7 games and others 3. The leaderboard ranks by SUMMED points, not per game. | `americano.ts:36-42, 62`; `usecases/americano.ts:47-61` | M | With an odd number of players, one person plays twice as often and wins the leaderboard on volume. | Engine sim + read |
| G10 | americano / mexicano | Personal points read `match_states.state.score.home/away`, which only the generic sport exposes. No sport gate on the americano kind was found. | `usecases/americano.ts:50-53`; `stages.ts:776-786`; `sports/generic/generic.ts:81` | M | An americano run on badminton/tennis/table-tennis shows everyone on 0 points, and mexicano pairs at random. | Inferred (no sport gate found by grep) |
| G11 | mexicano | The next round is generated only when EVERY stage fixture is `decided`. A `finalized` (core.finalize), `forfeited` or `abandoned` fixture blocks all later rounds, and the points query excludes `finalized`. | `stages.ts:769, 780` | M | Signing off one match, or one walkover, stops a mexicano session from ever producing its next round. | Read |
| G12 | americano | Keys are positional `am-r{r}-c{c}`. A roster change regenerates a different rotation, but no key is new, so nothing is inserted. The stage is excluded from roster drift, and Rebuild refuses it (`STAGE_NOT_ROOT`). | `americano.ts:52`; `stages.ts:2972-2980` | M | A late americano player is never scheduled, and the only fix is to delete and recreate the stage. | Read |
| G13 | all rebuildable kinds | Rebuild deletes in one committed transaction, then regenerates in another. If regeneration throws (custom `byes` count now wrong, page_playoff ≠4, group too small), the stage is left empty. It also NULLs every time and court, and the confirm doesn't say so (#840 OPEN). | `stages.ts:3103` then `3118`; memory `reference_rebuild_fixtures_button_wipes_the_schedule` | M | Pressing Rebuild can leave a division with no fixtures at all, and always erases the timetable. | Read |
| G14 | ko_plate (consolation) | The plate draws `roundLosers(round 1, count q)`, but a seed proposal requires the source stage COMPLETE, so the plate cannot start until the main final is played. With byes in the main draw, R1 has fewer losers than q, which gives `QUALIFICATION_INVALID`. | `stages.ts:4800`; `progression.ts:577-596`; `format-templates.ts:271-283` | M | Plate players wait idle until the main draw's final, and a main draw with byes can't seed its plate at all. | Inferred from read |
| G15 | league, group | Add match (the documented safe workaround for G1) puts each ad-hoc match in round `max+1` unless a round is passed. | `stages.ts:5761`; #879 part 2 | M | Each workaround match shows up as its own new round on the board and in the public view. | Read |
| G16 | all progression targets | Correcting a result in a completed source stage stales only `draft` seed proposals. A CONFIRMED proposal, or an `on_complete` `config.qualified`, keeps the old qualifier with no warning. | `stages.ts:5418`; `scoring.ts:~811-818` | L | After fixing a group result that changes who qualified, the knockout still holds the old qualifier. | Read |
| G17 | knockout / group / league | Unseeded entrants are ordered by `created_at`, so the first registrants get seed 1, byes and pool heads. There is no random-draw option anywhere. | `stages.ts:2293`; `roundrobin.ts:60-75` | L | Without manual seeds, the earliest sign-ups quietly get the best bracket positions. | Read (grep: no shuffle) |
| G18 | cross-stage feeds | A void un-fill (#856) and the dead-feeder cascade are both same-stage only, so cross-stage (`cross_feeds`) seats keep the old name. | `fed-seats.ts:40`; `stages.ts:3803-3820` comment | L | Voiding a match that fed another stage leaves the old winner in the other stage's draw. | Read (documented as deliberate scope) |
| G19 | group | Board cards for group fixtures read `R{n}` with no pool, because `BoardFixture` carries no `pool_id`. | `board/types.ts:31-37`; `round-codes.ts:85` | L | On a multi-pool day the schedule board can't show which pool a match belongs to. | Read |
| G20 | docs | The `round-codes.ts` comment says history restore "restores neither ext_key nor is_final". That is stale: `history.ts:404-431` restores both. | `round-codes.ts:106` | L | None directly; a future reader may add a needless guard. | Read |
| G21 | league / group odd field | The RR `bye` per round is dropped by `roundRobinGen`, so no row or label records who sits out. | `stages.ts:1604-1621` | L | Players in an odd-sized league can't see their bye round. | Read; UI effect inferred |
| G22 | group, 1 pool | `count === 1` returns before pool ids, so a single-pool group stage writes `pool_id` null. | `stages.ts:1638` | L | Minor: a one-group stage behaves like a league on pool-scoped reads. | Read |
| G23 | per-stage rules | Overrides are limited to 4 sets sports (owner D2a). Squash/pickleball/padel-style and non-sets sports can't vary Bo per stage. | `lib/match-rules.ts:956` | L | Only 4 sports can play Bo1 in the league and Bo3 in the playoff. | Read (scope, not defect) |
| G24 | double_elim | A no-show recorded as a forfeit (award) has no loser (`advancingSides`), so the loser edge is dead and the absent player is eliminated rather than dropped to the LB. | `fed-seats.ts:97-102`; `stages.ts:3686-3692` | L | A double-elim player who no-shows once is out entirely rather than dropping to the losers' bracket. | Inferred (arguably intended) |

Severity tally: **H 5** (G1, G2, G3, G6, G7) · **M 10** (G4, G5, G8, G9, G10, G11, G12, G13, G14, G15) · **L 9** (G16–G24). Total 24.

## Verified-closed / working (so they are not re-audited)
- #856 knockout void un-fill: same-stage winner and loser edges, flip-without-undecided, refusal when the next match has started, cascade-walkover reset (`fed-seats.ts`, `knockout-void-unfill.test.ts` 67K).
- #821 draw-list feeder labels and the dead-feeder cascade (`resolveBracketSeats`, loser edge included, 2026-09-21).
- F14: a departed qualifier becomes a walkover at generation and keeps the draw.
- History restore now restores `ext_key`/lane/is_final (`history.ts:404-431`), so a re-Generate after restore does not duplicate.
- Snake into a bracket target is refused (ruling 13, `progression.ts:270-300`).
- Round-robin home/away balance and leg mirroring (`roundrobin.ts` proof comment, formats-ext property test).
