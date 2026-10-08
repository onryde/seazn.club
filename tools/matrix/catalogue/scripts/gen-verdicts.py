#!/usr/bin/env python3
"""gen-verdicts.py: writes tools/matrix/catalogue/audit-verdicts.json.

    python3 tools/matrix/catalogue/scripts/gen-verdicts.py [out.json]      (default: the committed file, in place)

The committed file is rebuilt byte-identical from this script by tools/matrix/__tests__/catalogue-scripts.test.ts.

One verdict per audit id the triage does not reproduce (143). The wave of each is the id's route in gap-routing.json
(exact id, else the <PREFIX>-* wildcard), never typed here. Evidence is a person's sentence: what the baseline drives, and
what no check reads; a verified-by-read verdict cites the CURRENT file:line (the audit's own lines are stale: main moved).
"""
import json, sys
from pathlib import Path

CATALOGUE = Path(__file__).resolve().parents[1]
routes = json.load(open(CATALOGUE / "gap-routing.json"))["routes"]


def wave(i):
    if i in routes:
        return routes[i]
    w = routes.get(i.split("-")[0] + "-*")
    assert w is not None, i
    return w


NO = "not-exercised"
READ = "verified-by-read"
V = {}


def no(i, text):
    assert i not in V, i
    V[i] = (NO, text, None)


def read(i, text, drove=None):
    """`drove`: the baseline scenarios (LIFECYCLE, M1, R4, F1) whose run exercised the code this verdict reads while no check read
    the property (review m2): such an id is verified-by-read, never not-exercised."""
    assert i not in V, i
    V[i] = (READ, text, drove)


# ---------------------------------------------------------------- FX

# Review m2 (Task 19 fix round 1): the ids the baseline DROVE but no check reads. They were labelled not-exercised; a run that drives
# the code and passes is not "not exercised", it is an unchecked claim, so each is read from the CURRENT code (verified-by-read) and
# names the scenario that drove it. `ran` below = a one-off direct call of the engine function, not a baseline run.
read("FX-G4", "packages/engine/src/scheduling/bracket.ts:303-317: each losers-bracket major round pairs the winner of its previous-round game i with the loser of winners-bracket round m+1 game i, the same index, with no crossing of the drop order. Ran generateDoubleElim for 8 and 16 entrants with the favourite winning every game: 3 (lb-r1-i0, lb-r1-i1, lb-r3-i0) and 7 losers-bracket games pair two entrants who had already met, as the audit says. The baseline builds and plays double_elim on every sport (LIFECYCLE) but I2 reads one champion and a rank permutation only, so no check reads a rematch.", drove=["LIFECYCLE"])
read("FX-G8", "packages/engine/src/scheduling/americano.ts:35-42 rotates the field by a round-indexed offset around a fixed pivot and :44-63 takes contiguous quartets of that order, teams 1+4 v 2+3. Ran generateAmericano directly (not through the baseline): 8 players over 7 rounds make 21 distinct partner pairs of 28 (a pair repeats up to 2x), 16 players over 15 rounds 45 of 120 (up to 4x), the audit's figures. The baseline plays the americano rows on every sport (LIFECYCLE) but I10 reads only that each person is seated once per round.", drove=["LIFECYCLE"])
read("FX-G9", "packages/engine/src/scheduling/americano.ts:35-42 keeps the pivot at index 0 and :62 sends the tail of the order to the bench, so the pivot never sits out (ran generateAmericano directly: 6 players over 7 rounds, the pivot plays 7 games, the others 3 to 5); pairMexicanoRound takes the same tail of the points-sorted order (:93-96). apps/web/src/server/usecases/americano.ts:50-61 sums points and counts games, ordered by points. F1 drives the odd field on both rows but f1-everyone-drawn, f1-ladder-sweep and f1-round-size read the draw, the ladder and the round size, not games per person.", drove=["F1"])
read("FX-G10", "apps/web/src/server/usecases/americano.ts:50-53 and stages.ts:772-776 read state->'score'->>'home'/'away' off match_states.state, which apps/web/src/server/engine-db/append-event.ts:379-380 stores as the engine's fold state unchanged. Only GenericState carries a `score` key (packages/engine/src/sports/generic/generic.ts:81); SetBasedState (sports/setbased/kernel.ts:334-340: sets, setsWon) and FootballState (sports/football/football.ts:573-577: goals) do not, so the sum is 0 for them. The other kernels were not read. LIFECYCLE passes on every americano cell, but no check reads the personal leaderboard.", drove=["LIFECYCLE"])
read("FX-G21", "apps/web/src/server/usecases/stages.ts:1612-1620 maps schedule.fixtures only, while the engine returns the bye on each round (packages/engine/src/scheduling/roundrobin.ts:52, :127-128, :152), so roundRobinGen writes no row or label for it. F1 drives the odd league and group on every sport and f1-everyone-drawn reads that everyone is drawn, not that the bye is named.", drove=["F1"])
read("FX-G24", "apps/web/src/server/engine-db/fed-seats.ts:97-103 advancingSides names a loser only for a `win` (an `award` has a winner and no loser) and apps/web/src/server/usecases/scoring.ts:728-735 fills the loser edge only from that, so a recorded forfeit seats nobody in the losers bracket. apps/web/src/server/engine-db/competition.ts:151-164 bracketWinnerLoser DOES derive a loser from an award, so the engine projection and the fill disagree; what the cascade (scoring.ts:749-753 resolveBracketSeats) does with the empty losers-bracket seat was not read. M1 drives a one-match walkover on every double_elim cell and its checks read that it is recorded and the winner advances, not where the absent player goes.", drove=["M1"])
read("FX-G1", "apps/web/src/server/usecases/stages.ts:2438 builds byKey from the existing fixtures' ext_key and :2511 inserts only generated rows whose key is absent; a round-robin key is positional (packages/engine/src/scheduling/roundrobin.ts:140, `rr-r${roundNo}-c${court}`), so after roster growth the new pairings collide with existing keys and are skipped while others are created twice. P3 (Generate after a roster change) has no script in the baseline, so the harness never meets it.")
read("FX-G2", "The same reconcile serves every kind: apps/web/src/server/usecases/stages.ts:2438 (byKey) and :2511 (only absent keys are inserted); a bracket key is positional too (packages/engine/src/scheduling/bracket.ts:170 `${prefix}-r0-i${i}`, :197), so a new entrant inside the same bracket size lands on no new key and is never placed. P3 has no script.")
read("FX-G3", "Nothing writes the void: outside tests `gf-reset` appears only where it is generated (packages/engine/src/scheduling/bracket.ts:352-358: the `gf-reset` id at :354, `conditional: true` at :358), in a comment at packages/engine/src/scheduling/bracket.ts:350 that says 'the persistence adapter voids it', and in a comment at apps/web/src/server/engine-db/competition.ts:121; apps/web/src/server/usecases/stages.ts:1668 only passes bracketReset to the generator. No code is the adapter the comment names. No template or builder knob sets bracketReset (tools/matrix/lib/scenarios/terminal-finals.ts only reads it from the stage config).")
no("FX-G5", "Group to knockout round-1 pairing with 3 or 5 pools: the builder's poolCount knob defaults to 2 (tools/matrix/lib/catalogue.ts:47) and F4 (unequal pools) has no script, so a 3-pool or 5-pool field is never built; no check reads the round-1 pairing against the rank_order fold.")
read("FX-G6", "apps/web/src/server/usecases/stages.ts:5541 initialises ladder_order from the entrants registered at the first challenge and :5551 writes it once; apps/web/src/server/usecases/scoring.ts:776 only reorders the existing list on a result; :5562 refuses `LADDER_ENTRANT_FOREIGN` for anyone not on it. No code path appends a later entrant. R1/R2 (late entry) have no script, so no ladder cell meets it.")
no("FX-G12", "Americano roster change: P3 (Generate after a roster change), R1 (late entry before Start) and R2 (late entry after Start) have no script, so no americano cell changes its roster after the draw.")
no("FX-G13", "Rebuild after results exist: P4 has no script; a regeneration that throws also needs F2 (field below the format's minimum) after a rebuild, and F2 has no script either.")
no("FX-G15", "Add match after roster growth: no scenario adds an ad-hoc match and the scenario catalogue has no atom for it (P3 has no script either), so the round max+1 landing is never driven.")
no("FX-G16", "Correcting a result in a completed source stage: C6a (late correction after the stage is complete) and Q1 (qualifier decided, then a correction changes it) have no script.")
no("FX-G17", "Unseeded draw order: F8 (protected seeds) has no script, and no check reads which entrant gets seed 1 or a bye; the catalogue has no random-draw option to drive.")
no("FX-G18", "Cross-stage feeds: needs M7b (void a decided result after the next stage started) on a feeding stage; M7 has no script.")
no("FX-G19", "Group board cards read R{n}: a public board surface no layer reads (L1 and L3 read the HTTP API, L2 drives only F1, M1 and R4 through the organiser UI).")
read("FX-G20", "apps/web/src/components/v2/board/round-codes.ts:106-107 still says history.ts 'restores neither ext_key nor is_final'; apps/web/src/server/usecases/history.ts:425 inserts both columns (`ext_key, lane, is_final, third_place, conditional`) and :440 writes is_final. The comment is stale; it is code, not behaviour, so no scenario can read it.")
read("FX-G22", "apps/web/src/server/usecases/stages.ts:1638 `if (count === 1) return roundRobinGen(entrants, legs);` passes no poolId (the helper's poolId argument is optional, :1603-1608), so a one-pool group stage writes pool_id null. The harness's builder never builds one pool (poolCount is clamped to 2..8, tools/matrix/lib/catalogue.ts:55).")
no("FX-G23", "Per-stage rules on a non-sets sport: P6 (per-stage rule override) has no script, and the finding is a limit by owner ruling (D2a), not a behaviour a scenario can fail.")

# ---------------------------------------------------------------- SC

read("SC-S3", "packages/engine/src/sports/setbased/kernel.ts:2451-2458: the award branch pays the clean-sweep match points (cleanSweepPair) but its delta's metrics come from sideMetrics(state, side) (:2260-2265, :2436), the state's own played sets and points, so a walkover with nothing played credits zero sets and zero points; packages/engine/src/sports/nested/kernel.ts:2207-2213 does the same (sideMetrics at :2205). The federation convention (21-0 21-0) is the audit's claim and was not checked. M1 drives a one-match walkover on these sports on every format; its checks read that it is recorded and the winner advances, not the sets or points credited.", drove=["M1"])
read("SC-O7", "packages/engine/src/sports/boardgame/boardgame.ts:52 declares byeScore (default 2) and :713-740 pays a bye (an award) what a win pays, deliberately not reading cfg.byeScore (comment :726-731); packages/engine/src/scheduling/swiss.ts:35 documents it 'for the caller' and :48 says only the bye entrant is named. No file under apps/web/src names byeScore (grep of apps/web/src and packages/engine/src: only swiss, boardgame, the comment at competition/tiebreakers.ts:39 and tests), and apps/web/src/server/engine-db/competition.ts:87-116 awardByeDelta scores a bye through standingsDelta. F1 drives the odd field on every swiss and league boardgame cell, and f1-everyone-drawn reads the draw, not what a bye is worth.", drove=["F1"])
no("SC-X3", "Abandoned knockout match: M4a (abandoned, no result) has no script, so no knockout cell is abandoned.")
read("SC-X4", "apps/web/src/server/usecases/scoring.ts:819 counts `status <> 'decided' and status <> 'forfeited'` as still open, and apps/web/src/server/engine-db/append-event.ts:146 returns 'abandoned' whenever `core.abandon` is in the stream, even when the fold produced an outcome; so one abandoned league match blocks auto-advance. M4 has no script.")
no("SC-S1", "Impossible tennis tie-break games score: the baseline posts scores the harness builds (life-results-as-posted), never a malformed set summary, and E2 (single-event result over the API) has no script.")
no("SC-S2", "Tennis Bo1 with a match tie-break decider: needs the match-rules editor choice (E3 Bo1 points editor, X3 round shortened); neither has a script.")
no("SC-S4", "Retirement mid-match: M3 has no script.")
no("SC-S5", "Tennis match tie-break counted as zero games: M6 (tie after regulation to a decider) has no script, and no check reads games_won/games_lost.")
no("SC-S6", "Double forfeit on a set-based or nested sport: M2 (double walkover) has no script.")
no("SC-S7", "Tennis points_lost under a custom cascade: no scenario sets a tiebreak cascade (division.tiebreakers is API-only and the catalogue has no atom for it).")
no("SC-S8", "A claim about a unit test (setbased.test.ts asserts no award metrics): not a behaviour any scenario can reach; the matching behaviour is SC-S3.")
no("SC-S9", "Volleyball stage override to best of 3 on a FIVB-points division: P6 (per-stage rule override) has no script.")
read("SC-P1", "apps/web/src/server/engine-db/stage-cfg.ts:18 `STAGE_DECIDER_KEYS = [\"shootout\", \"extraTime\"]` and :35-37 overlay them from stage config, but no component under apps/web/src/components writes either key to a stage (the stage builder and stages-panel never mention them), while apps/web/src/lib/match-rules.ts:336 and :343 label the division-wide fields 'Knockout fixtures only.'. The engine's `resolveFullTime` takes no stage input (packages/engine/src/sports/football/football.ts). M6 has no script.")
read("SC-P2", "apps/web/src/server/engine-db/append-event.ts:337-345 refuses a level result with DRAW_NOT_ALLOWED when `supportsDraws(cfg, stage.kind)` is false, and packages/engine/src/sports/football/football.ts:2666-2668 returns false outside league/group/swiss; the fixture's config is frozen at its first event (apps/web/src/server/engine-db/fixture-cfg.ts:39-45), so a decider switched on afterwards does not reach it. M5/M6 have no script.")
no("SC-P3", "Ice hockey level overtime with the shoot-out off in a knockout: M6 has no script, and no scenario sets the overtime or shoot-out rules.")
no("SC-P4", "Shoot-out points split editable for football only: a match-rules editor limit; no scenario edits a division's match rules through the editor (D6/D7 change a stage's shape or rules).")
no("SC-P5", "Shoot-out recorded as won 1 / lost 1: M6 has no script, and no check reads the won/drawn columns of a decider game.")
no("SC-P6", "A claim about a unit test (football.test.ts folds a knockout case with no split): not a behaviour any scenario can reach.")
read("SC-P7", "packages/engine/src/sports/period/kernel.ts:88 and :194 declare `shootout.suddenDeath`, hockey.ts:142 and icehockey.ts:168 set it true, and nothing in packages/engine/src reads the field (a search of non-test source finds only these declarations and presets). M6 has no script.")
no("SC-P8", "Stage decider overlay keys from API v1 never validated: needs a stage created over the API with a decider key for the wrong sport; no scenario sets stage decider keys.")
no("SC-P9", "Abandon under abandonPolicy 'award' with a level score: M4b (abandoned with a result) has no script, and abandonPolicy is not a catalogue knob.")
no("SC-P10", "A stage PointsRule over API: no scenario sets a stage PointsRule (the catalogue has no atom for it; C5 points deduction is a different input).")
no("SC-P11", "No futsal preset: a feature that does not exist, so no cell can exercise it (tools/matrix/catalogue/variants.json holds no futsal variant).")
no("SC-P12", "Result-only (band 0) needs the full event stream: E2 (single-event result over the API) has no script.")
no("SC-P13", "A level ladder or stepladder challenge in football refused: M5 (draw in a stage that cannot end level) has no script.")
read("SC-C1", "apps/web/src/server/engine-db/append-event.ts:337 guards `kind === \"draw\"` only; packages/engine/src/sports/cricket/cricket.ts:945 folds a level finish with no super over to `{ kind: \"tie\" }` and :1179 a no-result to `{ kind: \"no_result\" }`; packages/engine/src/sports/cricket/cricket.ts:3964 supportsDraws is false in a knockout but is asked of a draw only; apps/web/src/server/engine-db/competition.ts:158-163 bracketWinnerLoser returns no winner for either, so the bracket has nothing to advance. M5/M6 have no script.")
read("SC-C2", "apps/web/src/lib/match-rules.ts:454-460 offers `superOver` ('Super over on a tie', help 'Knockout fixtures only.') as one division-wide field, and apps/web/src/server/engine-db/stage-cfg.ts:18 lists only shootout and extraTime as stage decider keys, so superOver cannot be set per stage. M6 has no script.")
no("SC-C3", "Cricket NRR for a DLS or revised-overs result: M4b (abandoned with a result, a DLS decision) has no script.")
no("SC-C4", "Coarse innings summary with no upper bound: E2 (single-event result over the API) has no script, and the harness posts finished innings it builds itself.")
no("SC-C5", "A claim about unit-test coverage (cricket.test.ts has no DLS NRR operand test): not a behaviour any scenario can reach; the matching behaviours are SC-C1 and SC-C3.")
no("SC-C6", "Coarse boundaries have no pad path: E1 (phone pad) has no script on cricket at coarse fidelity (L2 drives only F1, M1 and R4).")
no("SC-C7", "Overs per innings editor writes ballsPerInnings = overs x 6: a match-rules editor value; no scenario edits cricket match rules.")
no("SC-C8", "Super over is band 3 only: M6 has no script and E1 (phone pad) drives no cricket knockout.")
no("SC-O3", "Generic knockout with allowDraws on: M5 (draw in a stage that cannot end level) has no script.")
no("SC-O4", "Carrom tieBoard 'draw' in a level knockout: M5/M6 have no script.")
read("SC-O5", "apps/web/src/server/engine-db/append-event.ts:337 refuses `kind === \"draw\"` only, and apps/web/src/server/engine-db/competition.ts:158-163 bracketWinnerLoser returns {} for `no_result`, so an abandon or double forfeit that folds to no_result seats nobody. M2/M4 have no script, so no knockout cell is abandoned or double-forfeited.")
no("SC-O6", "Carrom has no result-only entry: E2 (single-event result over the API) has no script.")
no("SC-O8", "No per-stage format override outside the four sets sports: P6 has no script, and the finding is a limit by owner ruling (D2a).")
no("SC-O9", "Carrom game adjust has no upper bound: a pad/API event the harness never posts; E1/E2 have no script.")
no("SC-O10", "Boardgame result method and winner not cross-checked: needs a malformed event over the API; E2 has no script.")
no("SC-O11", "Generic 500-point cap is pad-only: E1 (phone pad) has no script on generic and E2 has none.")
no("SC-O12", "Team chess unsupported: a feature that does not exist (entrant kinds are individual only), so no cell can exercise it.")

# ---------------------------------------------------------------- ST

read("ST-G17", "packages/engine/src/competition/qualification.ts:95: `if (!input.anyPlayed || input.complete) return null`, so a completed stage's table carries no markers or legend, as the audit reads. LIFECYCLE completes every stage and life-public-standings-match reads the table, but no check reads the cut line or legend.", drove=["LIFECYCLE"])
read("ST-G30", "apps/web/src/server/usecases/scoring.ts:101 TABLE_KINDS is league, group, swiss and :790-791 recomputes the standings snapshot only for those kinds, so a decided americano fixture refreshes no snapshot there (engine-db/competition.ts:39's own TABLE_KINDS does include americano; the stage-completion path was not read). LIFECYCLE reads the table after life-stage-completed, never between two results.", drove=["LIFECYCLE"])
read("ST-G1", "apps/web/src/server/engine-db/append-event.ts:146 returns 'abandoned' whenever `core.abandon` is in the stream, and apps/web/src/lib/fixture-engine-status.ts:17-18 maps 'abandoned' to 'void', which packages/engine/src/competition/stage.ts:24 keeps out of the standings fold (COUNTS_FOR_STANDINGS is decided and walkover), so a cricket no-result earns nothing and sits in no NR column. M4 has no script.")
read("ST-G2", "apps/web/src/components/public-site/standings-table.tsx:374 prints the structural column with `formatMetric(row[col.key])`, and packages/engine/src/sports/boardgame/boardgame.ts:702 stores `points: pts` in half-points (win = 2), so the Pts cell reads 2 for a win; the engine's half-point text helper (packages/engine/src/competition/tiebreakers.ts:180) is not used by this table. life-public-standings-match compares org and public rows with each other, both raw, so it cannot see it.")
read("ST-G3", "apps/web/src/lib/format-templates.ts:140 sets `normaliseUnequalPools: true`, and packages/engine/src/competition/progression.ts:550-552 makes normalisedRow a no-op when `PoolTable.results` is absent, which its own comment (:436-438) says is every caller; no production caller builds a PoolTable with results. F4 (unequal pools) has no script.")
no("ST-G4", "Cross-pool best-Nth comparison ignores the sport's cascade: F4 (unequal pools) and P2 (group to knockout with a tie unresolved) have no script, and no check reads which runner-up is chosen.")
no("ST-G6", "Recap and weekly digest posts omit pooled standings: a generated post surface no layer reads.")
no("ST-G7", "Completed bracket writes an all-zero snapshot read by embed, /present and OG: surfaces no layer reads; life-public-standings-match compares the org and public tables, which agree (both zero).")
no("ST-G8", "A stage PointsRule has no UI: no scenario sets a PointsRule (the catalogue has no atom for it).")
no("ST-G9", "Cricket tie scores 0 under a custom PointsRule: no scenario produces a cricket tie (M6 has no script) or sets a PointsRule.")
no("ST-G10", "Tiebreak cascade is division-level only and validateCascade is never called: no scenario sets a cascade (division.tiebreakers is API-only, no atom).")
no("ST-G11", "UEFA recursive h2h unreachable: F5a/F5b (ties) have no script.")
no("ST-G12", "h2h mini-table from a partial tie group: F5b (three-or-more-way tie) has no script.")
no("ST-G13", "Residual ties ordered by seed then UUID: F7 (tie falling through to lots) has no script, and no check reads an order that ties leave to the cascade's end.")
no("ST-G14", "Rank override rejects a duplicate rank across pools: P7 (rank override) has no script.")
no("ST-G15", "Expunge skips finalized fixtures: R4c (under half played, some of the entrant's fixtures finalized) has no script (L2 shows R4c not_run on all 21 cells; the baseline's R4 is the none-finalized atom).")
no("ST-G16", "No OT/SO columns: M6 (decider) has no script, and no check reads which column a decider game lands in.")
no("ST-G18", "Same-round knockout losers get distinct ranks: Q3 (third-place match skipped, shared 3rd) has no script; I2 abstains on a declared shared place, so it neither pins nor refuses the distinct ranks.")
no("ST-G19", "No running public ladder view: no layer reads a running ladder's public page; life-public-standings-match reads the completed stage only.")
no("ST-G20", "Hub tables have no withdrawn chip: R3/R4 withdraw an entrant and r4-* read the cascade (fixtures, seats), not the hub table; no layer reads the hub.")
no("ST-G21", "Slideshow columns and truncation: a surface (/present) no layer reads.")
no("ST-G22", "Recap/digest names bypass consent masking: a generated post surface no layer reads.")
no("ST-G23", "Standings endpoints declare no response: an OpenAPI declaration, not a behaviour a scenario drives.")
no("ST-G24", "Standings export holds one snapshot: the export surface is not read by any layer.")
no("ST-G25", "Developer guide uses a field that does not exist: a docs page no layer reads.")
no("ST-G26", "OG image picks an unordered row: a surface no layer reads.")
no("ST-G27", "Email standings block has no caller: a template no layer reads.")
no("ST-G28", "Private standings GET without pool_id on a pooled stage returns no rows: the harness reads standings per pool by its id (the observed stage's standings carry a poolId), never the pool-less call.")
no("ST-G29", "Tennis game_ratio has no derived column: a table header no layer reads (L2 drives only F1, M1 and R4 through the organiser UI).")
no("ST-G31", "Default cascades diverge from federation rules: a rulebook finding; F5a/F5b (ties) have no script and no check compares a table order against a federation cascade.")
no("ST-G32", "A claim about unit-test coverage (no table-order test for tennis, table tennis or cricket from real deltas): not a behaviour any scenario can reach.")
no("ST-G33", "A claim about unit-test coverage (double-elim ranks tested with 2 entrants, pooled locks, void with a result): not a behaviour any scenario can reach.")

# ---------------------------------------------------------------- SW

read("SW-M1", "packages/engine/src/competition/tiebreakers.ts:726-742: buildSwissTable pushes the awards (byes) onto each card AFTER every played result, so a bye is always the last game, and the virtual opponent's score (:63-68) is scoreBefore + (rounds - gameIndex) by position in that card, so a round-1 bye is scored as if it were the last. F1 drives swiss on every sport with an odd field and passes, but no check reads Buchholz.", drove=["F1"])
read("SW-M6", "packages/engine/src/competition/points.ts:57-59 treats every `award` as a forfeit, :133-134 pays it forfeit.winnerPoints and :146-151 adds forfeit.awardScore to for/against/diff; apps/web/src/server/engine-db/competition.ts:87-116 awardByeDelta runs that rule over a bye (:106). F1 drives swiss byes and passes, but no check reads what a bye is worth in the table.", drove=["F1"])
read("SW-M8", "The same reading as SC-O7: packages/engine/src/sports/boardgame/boardgame.ts:52 declares byeScore and :713-740 never reads it (comment :726-731), packages/engine/src/scheduling/swiss.ts:35 only documents it, and apps/web/src names it nowhere, so a bye is a full win. F1 drives swiss byes and passes, but no check reads what a bye is worth.", drove=["F1"])
read("SW-L3", "packages/engine/src/scheduling/swiss.ts:162-178 picks the bye once, before any matching, and :280-282 answers a failed matching with no pairings and that same bye, so it is never retried, as the audit reads. The audit's consequence (2 cases in ~40k rounds) is a probabilistic finding that one seeded field per cell cannot witness: F1 passes on every swiss cell.", drove=["F1"])
read("SW-L4", "packages/engine/src/scheduling/swiss.ts:135-142: floaterChoices considers only the bottom Math.max(fc + 3, 4) entrants of a group (comment :134). Whether that ever misses a legal float is the audit's claim and was not read: the baseline plays one seeded field per cell, and I6/I4 read it, which cannot witness a rare shape.", drove=["LIFECYCLE"])
read("SW-L5", "packages/engine/src/scheduling/swiss.ts:296-305: for a non-chess field assignColours returns `home: a.entrantId` with `a` the upper board, so the stronger side is always home. LIFECYCLE plays swiss on every sport, but no check reads home/away alternation.", drove=["LIFECYCLE"])
no("SW-M2", "Undo of Pair next round: P5b (undo Pair next round) has no script.")
no("SW-M3", "Ad-hoc match gives everyone a phantom bye: no scenario adds an ad-hoc match and the catalogue has no atom for it.")
no("SW-M4", "Ad-hoc fixtures break the shell model: no scenario adds an ad-hoc match and the catalogue has no atom for it.")
no("SW-M5", "Unpair can clear an ad-hoc fixture: no scenario adds an ad-hoc match and the catalogue has no atom for it; P5b has no script.")
no("SW-M7", "A bye never freezes config_snapshot: needs a match-rules edit after a bye; no scenario edits match rules (D6/D7 change a stage's shape or rules).")
no("SW-M9", "Double walkover on a swiss board: M2 has no script.")
read("SW-M10", "apps/web/src/server/usecases/stages.ts:513-516 refuses `FORMAT_LOCKED` (409) when any fixture of the division exists, and unpaired swiss shells are fixtures; openapi.ts lists no stage PATCH route (apps/web/src/server/api-v1/openapi.ts:140-144 has generate, unpair, rebuild, complete, standings). life-format-edit-refused-named edits the division's match format, not the stage's round count, so it neither pins nor sees this. D6 (format changed after entries close) has no script.")
no("SW-M11", "Pairing groups ignore the table's points: no scenario sets a custom points rule on a swiss stage.")
no("SW-M12", "Rebuild wipes the swiss schedule: P4 (Rebuild after results exist) has no script.")
no("SW-M13", "A bye shell scheduled onto a court: needs a timed swiss schedule; L3 excludes the cases that need times (D5b, X1), and F1 never schedules.")
no("SW-L1", "Two-sided walkover in Buchholz/SB: M2 has no script.")
no("SW-L2", "Virtual opponent mis-scaled for non-chess Buchholz: no scenario sets a Buchholz cascade on a non-boardgame sport (division.tiebreakers is API-only).")
no("SW-L6", "Unseeded round 1 folds by registration order: a feature absent (no random-draw option); F8 (protected seeds) has no script.")
no("SW-L7", "No late entry after Start: R2 (late entry after Start) has no script.")
no("SW-L8", "Surplus boards deleted from the highest seq: needs a field-size reshape after pairing; R3/R4 on swiss do not reshape a paired round and no script drives one.")
no("SW-L9", "A claim about a unit test (the no-rematch property passes on an empty round): not a behaviour any scenario can reach; I6-swiss-no-rematch reports its own counts.")
no("SW-L10", "A claim about the e2e spec inventory (no browser spec drives a swiss to its knockout cut): L2 drives only F1, M1 and R4 and none to a knockout cut; no browser scenario reaches it.")
no("SW-L11", "Public surfaces have no swiss round state: no layer reads a swiss public page for round state.")
no("SW-L12", "No pairing preview or manual board swap for rounds 2+: a feature absent; no scenario can drive it.")
read("SW-H2", "apps/web/src/components/v2/division-builder.tsx:290 defaults swissRounds to 5 and :846-856 renders the input min 1 / max 15; apps/web/src/lib/swiss-rounds.ts:40 swissRoundsForFieldSize has no production caller (its callers are apps/web/src/lib/__tests__/swiss-rounds.test.ts and two usecase tests).")
read("SW-H3", "apps/web/src/server/usecases/stages.ts:1196 passes `chess: cfg.chess === true`; only apps/web/src/server/api-v1/schemas.ts:1075 accepts the key, and neither apps/web/src/lib/format-templates.ts, apps/web/src/server/templates/catalog/swiss11.json (config is `{ \"rounds\": 11 }`) nor any component under apps/web/src/components/v2 writes it. No scenario sets it (tools/matrix mentions chess in comments only), so chess colour balancing is never on.")
read("SW-H4", "apps/web/src/server/engine-db/competition.ts:392 `return inputs.division.tiebreakers ?? inputs.module.defaultTiebreakers;` is not stage-kind-aware; packages/engine/src/sports/setbased/badminton.ts:56 ends in set_ratio, point_ratio, h2h_points with no Buchholz; no file under apps/web/src/components mentions `tiebreakers`, and the division page only reads it (apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:418).")

# ---------------------------------------------------------------- SH
read("SH-G1", "apps/web/src/components/v2/print-scorer-sheets.tsx:95 posts `{ date: day }` only, the one mount is the competition schedule page (apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx:199), and apps/web/src/server/api-v1/key-scopes.ts:394 keeps `POST /competitions/:id/exports/scorer-sheets` session-only, while the route accepts divisionId, dateFrom, dateTo and groupBy (apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/route.ts:30). E4b has no script.")
SH = {
    "SH-G2": "Printed links never re-check the entitlement: E4b (printed scorer-sheet scan) has no script; L3 excludes it (needs times).",
    "SH-G3": "No bulk revoke of a printed day: E4b (printed scorer-sheet scan) has no script; L3 excludes it (needs times).",
    "SH-G4": "Unscheduled fixtures cannot print: E4b has no script, and L3 excludes the cases that need times.",
    "SH-G5": "Non-Latin names have no glyphs: E4b has no script; the owner accepted it (plan Q10).",
    "SH-G6": "No paper fallback or format on the card: by design (D5); E4b has no script.",
    "SH-G7": "No real sport is exercised from a sheet: E4b has no script, which is the sport-by-format sheet sweep this finding asks for.",
    "SH-G8": "Group, double-elim and playoff sheets untested: E4b has no script, which is the format sweep this finding asks for.",
    "SH-G9": "A whole-competition print is one long transaction: E4b has no script.",
    "SH-G10": "A cut-out card carries no court: E4b has no script; the printed card is a PDF surface no layer reads.",
    "SH-G11": "The scan screen names the court differently from the sheet: E4b has no script.",
    "SH-G12": "No reprint prompt after a reschedule: E4b has no script, and D5b/X1 (timed schedule changes) have none.",
    "SH-G13": "Analytics and filename wrong for range/division prints: E4b has no script; the export's filename and analytics are a surface no layer reads.",
    "SH-G14": "dateFrom > dateTo not validated: E4b has no script.",
    "SH-G15": "Division sheet order is by name: E4b has no script.",
    "SH-G16": "An unpaired swiss bye shell is not excluded from print: E4b has no script, and F1 never schedules a swiss shell.",
    "SH-G17": "A grand-final reset prints like any match: E4b has no script, and no scenario sets bracketReset.",
    "SH-G18": "Cards for future swiss rounds can die: E4b has no script and no scenario reshapes a paired swiss.",
    "SH-G19": "A withdrawn entrant's match still prints: E4b has no script, and R4 does not print.",
    "SH-G20": "The scan-side lineup catalog reads the division config, not the stage overlay: E4b has no script.",
}
for k, t in SH.items():
    no(k, t)

out = {"verdicts": []}
for i in sorted(V, key=lambda x: (x[:2], int(''.join(c for c in x.split('-')[1] if c.isdigit())) if x.split('-')[1][0] in 'GXSPCOMLH' else 0, x)):
    o, t, d = V[i]
    out["verdicts"].append({"id": i, "outcome": o, "evidence": t, "wave": wave(i), **({"drove": d} if d is not None else {})})
n = len(out["verdicts"])
print("verdicts", n)
assert n == 143, n
with open(sys.argv[1] if len(sys.argv) > 1 else CATALOGUE / "audit-verdicts.json", "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write("\n")
from collections import Counter
print(Counter(v["outcome"] for v in out["verdicts"]))
print(Counter(v["wave"] for v in out["verdicts"]))
