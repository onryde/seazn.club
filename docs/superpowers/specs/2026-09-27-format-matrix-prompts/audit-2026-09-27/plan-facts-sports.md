# Part F — per-sport finalize / draw / walkover sequences (engine facts)

Worktree: `.claude/worktrees/format-matrix` @ 3136e1c1a. All paths relative to it.
Every claim below was read in the file cited; "INFERRED" marks a result derived
from reading code with no test pinning it.

## 0. Common envelope + app-side rules (all 11 sports)

### Wire body — POST /api/v1/fixtures/{id}/events
`apps/web/src/server/api-v1/schemas.ts:1420`
```ts
export const AppendEventRequest = z.object({
  expected_seq: z.number().int().min(0),
  type: z.string().min(1).max(100), // 'cricket.ball', 'core.void', …
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
```
- `expected_seq` = the ledger's CURRENT last seq (0 on an empty ledger); the new
  event gets `expected_seq + 1`; mismatch → `SEQ_CONFLICT` (409).
  `apps/web/src/server/engine-db/append-event.ts:207-216, 238`. Real API caller
  does exactly this: `scripts/seed-demo.ts:384-398` (`expected_seq: seq`, then
  `seq = r.seq` from the 201 body).
- Scoring is refused until the division is started:
  `WRONG_PHASE "division has not started — scoring is closed"` —
  `apps/web/src/server/usecases/scoring.ts:494-495`.
- Undo: `type: "core.void", payload: { event_id: <target event uuid> }` — the
  usecase lifts `payload.event_id` into the envelope's `voids`
  (`scoring.ts:200-203`); example `apps/web/src/server/usecases/__tests__/competition-schedule-ai-route.test.ts:1144`.
- Only remaining entitlement gate at the scoring door is DLS (cricket)
  (`scoring.ts:443-452, 565, 595`). No fidelity-band gate.

### Side naming: ENTRANT IDs, never "home"/"away"
Every `by` / `wonBy` / `winner` / `winnerId` / `firstBreak` field is an
`EntrantId` = the fixture's `home_entrant_id` / `away_entrant_id` UUID.
Lineups are built with `entrantId = fixture.home_entrant_id/away_entrant_id`
(`apps/web/src/server/engine-db/append-event.ts:245-250` →
`apps/web/src/server/engine-db/lineups.ts:36-70`); modules map an id to a side
via `sideOf` and throw `INVALID_EVENT unknown entrant` otherwise
(e.g. `packages/engine/src/sports/generic/generic.ts` `sideOf`). Engine tests use
the literal ids `"H"`/`"A"` because `defaultLineupPair` names the entrants so
(`packages/engine/src/testkit/helpers.ts:66-71`). Lineup rows are OPTIONAL for
these sequences: `loadLineupPair` returns `slots: []` when none exist and
`seed-demo.ts` scores every sport with no lineups.

### Core events (kernel-owned) — `packages/engine/src/core/events.ts:51-108`
```ts
export const CoreStart = z.strictObject({}); // scheduled → in_play
export const CoreVoid = z.strictObject({}); // target id travels in envelope.voids
export const CoreForfeit = z.strictObject({ by: EntrantId, reason: z.string().min(1) });
export const CoreAbandon = z.strictObject({ reason: z.string().min(1) });
export const CoreFinalize = z.strictObject({}); // locks ledger
export const CoreNote = z.strictObject({ text: z.string().min(1) });
export const CoreAward = z.strictObject({ person: z.string().min(1), key: z.string().min(1) });
export const CoreSuspend = z.strictObject({ reason: z.string().min(1).optional(), at: GameTime.optional() });
export const CoreResume = z.strictObject({ at: GameTime.optional() });
// + core.lineup.{substitution,replacement,position,retirement,entry}
```
- Once `outcome !== null`, only `core.note`, `core.finalize`, `core.award` (+ module
  `postDecisionTypes`) are accepted; anything else → `ALREADY_DECIDED`
  (`events.ts:437, 597-603`).

### Outcome kinds — `packages/engine/src/core/types.ts:115-139`
`win {winner, loser, method?}` | `draw` | `tie` | `no_result` | `award {winner, score?, method?}`.

### Finalize is AUTOMATIC; `core.finalize` is an optional lock
Fixture status is derived from the fold on every append
(`apps/web/src/server/engine-db/append-event.ts:118-149`):
```ts
if (candidateType === "core.finalize") return "finalized";
...
if (has("core.abandon")) return "abandoned";
if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
return has("core.start") ? "in_play" : "scheduled";
```
So the terminal sport event alone yields status `decided` (standings/progression
read it). `core.finalize` (or `POST /api/v1/fixtures/{id}/finalize`, body
`{ expected_seq }` — `apps/web/src/server/api-v1/openapi.ts:168`) only locks the
ledger (`finalized` ∈ `LOCKED_FIXTURE_STATUSES`, `append-event.ts:102`); every
module refuses it on an undecided fixture (`cannot finalize an undecided fixture`,
e.g. `football.ts:2144-2146`). Device links may not finalize (`scoring.ts:503`).
`seed-demo.ts` never sends a finalize.

### Walkover / forfeit / retirement — UNIVERSAL
`core.forfeit { by: <FORFEITING/RETIRING entrant>, reason: "<free text>" }` →
`award` to the OPPONENT, `method = reason` (boardgame: `win`, method `"forfeit"`).
Pinned for all 11 modules by `packages/engine/src/core/forfeit-reason.test.ts:56-95`
with the stream `[core.start, core.forfeit {by:"A", reason:"walkover"}]` → winner "H".
- Retirement = the same event; the organiser console sends
  `core.forfeit { by: own.id, reason: "retired hurt" }`
  (`apps/web/src/components/v2/__tests__/fixture-console-forfeit-hooks.test.tsx:120-123`).
- `core.start` first is the SAFE form: boardgame REFUSES forfeit outside `live`
  (`boardgame.ts:617`); generic/cricket/football/period/setbased/nested/carrom
  accept it from `pre` too (their `applyForfeit` only refuses done/final/abandoned,
  e.g. `setbased/kernel.ts:804-814`). App tests do send it at `expected_seq: 0`
  (`apps/web/src/server/usecases/__tests__/discipline.test.ts:880`).
- Football/hockey/icehockey award score = `cfg.awardScore.goals` (3 / 3 / 5)
  (`football.ts:1635-1651`, `period/kernel.ts:1429-1444`).
- Status → `forfeited` (not `decided`).

### Abandon — PER-SPORT (see table)
`core.abandon { reason }`; status always → `abandoned` (`append-event.ts:146`).

## Summary table

| sport | winner seq | draw? | abandon → outcome | quick/coarse entry event |
|---|---|---|---|---|
| football | start, goal×N, period HT, period FT | yes (default cfg, level at FT) | `replay` (default): undecided; `award`: leader wins / no_result if level | none (goals + markers) |
| cricket | start, innings.summary×2 | `tie` (1-inn, default); `draw` only 2-innings | 1-inn: DLS win/tie if enabled & min overs, else `no_result`; 2-inn: `draw` | `cricket.innings.summary` |
| boardgame | start, boardgame.result {winner} | yes: `{winner:null}` | undecided (`abandoned`) ; `double_forfeit` → `no_result` | `boardgame.result` |
| carrom | start, board.summary ×6 (2 games ×3 boards @9) | only cfg `tieBoard:"draw"` | `no_result` | `carrom.board.summary` (per board) |
| generic | (start optional) generic.result | only cfg `allowDraws:true` | `no_result` | `generic.result` |
| volleyball | start, set.summary ×3 | no (bestOf odd) | undecided | `volleyball.set.summary` |
| badminton | start, game.summary ×2 | no | undecided | `badminton.game.summary` |
| tabletennis | start, game.summary ×3 | no | undecided | `tabletennis.game.summary` |
| tennis | start, set_summary ×2 | no | undecided | `tennis.set_summary` |
| icehockey | start, goal, advance P2, P3, FT | not with default (OT+GWS); yes with `recreational` variant | `replay` default: undecided | none |
| hockey | start, goal, advance Q2,Q3,Q4,FT | yes (default: no OT/shootout) | `replay` default: undecided | none |

`W`/`L` below = winner / loser entrant id. All sequences are the literal
`{type, payload}` list you POST, in order.

---

## 1. football
Default cfg: `packages/engine/src/sports/football/football.ts:66-95`
(`halves: 2`, `extraTime {enabled:false}`, `shootout:false`, `points 3/1/0`,
`awardScore {goals:3}`, `abandonPolicy:"replay"`). Variants `football.ts:2447+`
(`11-a-side: {}`, `youth`, `small-sided`, …).
Events (`football.ts:213-285`): `football.goal {by, scorer?, assist?, minute?, ownGoal?, penalty?, at?}`,
`football.period {phase: "HT"|"FT"|"ET_HT"|"ET_FT"|"QT"|"3QT", addedMinutes?, at?}`,
`football.shootout.kick {by, person?, scored, at?}`.
FT logic `resolveFullTime` `football.ts:1000-1024`: leader wins (`regulation`/`extra_time`);
level → ET if `extraTime.enabled`, else SHOOTOUT if `shootout`, else `draw`.

Winner (seed-demo.ts:159-174; test football.test.ts:62-69 shape):
```json
[{"type":"core.start","payload":{}},
 {"type":"football.goal","payload":{"by":"W","minute":10}},
 {"type":"football.period","payload":{"phase":"HT"}},
 {"type":"football.period","payload":{"phase":"FT"}}]
```
Draw (default cfg) — `football.test.ts:62-80` (1-1 → `{kind:"draw"}`), or 0-0:
`[core.start, football.period{HT}, football.period{FT}]`.
Knockout-style decider (cfg `{extraTime:{enabled:true,halfMinutes:15}, shootout:true}`,
`football.test.ts:45-48, 97-125`): `start, HT, FT(level→ET_H1), ET_HT, ET_FT(level→SHOOTOUT),
shootout.kick{by,scored}` alternating home-first; decided → `win method:"shootout"`.
Abandon: `football.ts:1653-1675` — `replay` ⇒ `phase:"abandoned"`, no outcome;
`award` ⇒ leader `award`, level ⇒ `no_result`.

## 2. cricket
Default cfg `packages/engine/src/sports/cricket/cricket.ts:43-135`
(`inningsPerSide:1`, `ballsPerInnings:120`, `ballsPerOver:6`, `playersPerSide:11`,
`points {win:2,tie:1,noResult:1,loss:0}`, `superOver:false`, `dls.enabled:false`,
`minOversForResult:5`). Variants `cricket.ts:3549+` (`t20`, `odi`, `hundred`, `test`, …).
Coarse event `cricket.ts:231-238`:
```ts
export const CricketInningsSummary = z.strictObject({
  runs: z.number().int().nonnegative(),
  wickets: z.number().int().nonnegative(),
  legalBalls: z.number().int().nonnegative(),
  declared: z.boolean().optional(),
  boundaries: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
});
export const CricketToss = z.strictObject({ wonBy: EntrantId, elected: z.enum(["bat", "bowl"]) });
```
Toss is optional; without it HOME bats first (`battingFirst: "home"`, `cricket.ts:3626`);
if sent it must precede `core.start` (`cricket.ts:3668`). An innings auto-closes on
all-out / balls exhausted / target passed.
Winner, HOME (bats first) wins — `cricket.test.ts:543-552`:
```json
[{"type":"core.start","payload":{}},
 {"type":"cricket.innings.summary","payload":{"runs":180,"wickets":4,"legalBalls":120}},
 {"type":"cricket.innings.summary","payload":{"runs":150,"wickets":10,"legalBalls":100}}]
```
→ `win winner:H`, margin runs 30. AWAY wins: second summary passes the target,
e.g. `{"runs":181,"wickets":3,"legalBalls":90}` (target-passed auto-close; INFERRED
from the auto-close rule comment at `cricket.ts:225-229`; seed-demo does this at
`seed-demo.ts:175-208` with `chase = first + 1 + rnd`).
Tie (no draw in 1-innings): equal runs, both innings complete — `cricket.test.ts:1037-1045, 1141-1144`
(`150/5 in 120` vs `150/7 in 120`, cfg without superOver ⇒ `{kind:"tie"}`).
Draw: only `inningsPerSide:2` (`cricket.match.close {}` or abandon ⇒ `draw`, `cricket.ts:254, 1141-1145`).
Abandon `cricket.ts:1141-1180`: 2-innings ⇒ `draw`; in super over ⇒ `tie`;
DLS enabled + chase ≥ minOvers ⇒ DLS `win`/`tie`; else ⇒ `no_result`
(test `cricket.test.ts:682-689`).
Seed-demo uses progressive `partial:true` summaries (`seed-demo.ts:186-206`); one
final summary per innings is enough.

## 3. boardgame
Default cfg `packages/engine/src/sports/boardgame/boardgame.ts:46-87`
(`scoring {win:2,draw:1,loss:0}`, `colors:true`, `byeScore:2`, `variant:"classical"`).
Variants `boardgame.ts:579-584` (`classical`/`rapid`/`blitz`).
Event `boardgame.ts:104-164`:
```ts
export const BoardgameMethod = z.enum(["checkmate","resign","time","agreement","stalemate",
  "insufficient","forfeit","adjudication","double_forfeit","repetition","fifty_move",
  "dead_position","illegal_move"]);
export const BoardgameResult = z.strictObject({
    winner: EntrantId.nullable().optional(),
    method: BoardgameMethod.optional(),
    moves: z.number().int().nonnegative().optional(),
    winnerPerson: PersonId.optional(),
  }).refine(/* at least one fact */);
```
`decideResult` `boardgame.ts:243-280` requires phase `live` (so `core.start` first).
Winner (`seed-demo.ts:210-215`):
```json
[{"type":"core.start","payload":{}},
 {"type":"boardgame.result","payload":{"winner":"W","method":"checkmate"}}]
```
Draw: `{"winner":null,"method":"agreement"}` ⇒ `{kind:"draw"}` (no cfg gate).
No-result: `{"winner":null,"method":"double_forfeit"}` ⇒ `no_result`.
Walkover: `core.forfeit` (must be `live`, `boardgame.ts:616-629`) ⇒ `win method:"forfeit"`,
or `boardgame.result {winner:W, method:"forfeit"}`.
Abandon `boardgame.ts:631-636`: `phase:"abandoned"`, no outcome.

## 4. carrom
Default cfg `packages/engine/src/sports/carrom/carrom.ts:51-73`
(`gameTo:25`, `maxBoards:8`, `bestOf:3`, `queenPoints:3`, `queenCapAt:22`,
`pointsPerCoin:1`, `tieBoard:"extra"`, `points {win:2,loss:0,draw:1}`).
Variants `carrom.ts:817-823` (`icf: {}`, `club-29`).
Events `carrom.ts:88-125`:
```ts
export const CarromToss = z.strictObject({ firstBreak: EntrantId });   // before core.start only
export const CarromBoardSummary = z.strictObject({
  winner: EntrantId,
  opponentCoinsLeft: z.number().int().min(0).max(9),
  queenTo: EntrantId.nullable().optional(),
  breaker: PersonId.optional(),
  queenBy: PersonId.optional(),
});
export const CarromGameAdjust = z.strictObject({ entrantId, delta /*≠0*/, reason, person? });
```
Board points = `opponentCoinsLeft × pointsPerCoin` (+ queen if under cap) — `applyBoard` `carrom.ts:374-418`;
game won at ≥ `gameTo` or leader after `maxBoards`; match = majority of `bestOf` (`carrom.ts:300-350`).
Winner, default cfg (2 games × 3 boards of 9 = 27 ≥ 25; board-helper shape from `carrom.test.ts:34-39, 158-160`):
```json
[{"type":"core.start","payload":{}},
 {"type":"carrom.board.summary","payload":{"winner":"W","opponentCoinsLeft":9,"queenTo":null}},
 ... same ×6 total ...]
```
Shorter with cfg `{bestOf:1}`: 3 boards.
Draw: needs cfg `tieBoard:"draw"`; minimal `carrom.test.ts:502-516` — cfg
`{gameTo:100,maxBoards:1,bestOf:1,tieBoard:"draw"}`, stream
`[core.start, carrom.board.summary {winner:"H",opponentCoinsLeft:0,queenTo:null}]` ⇒ `draw`.
Abandon `carrom.ts:465-470` ⇒ `phase:"abandoned"`, `outcome: no_result`.
NOTE: seed-demo.ts has NO carrom case (falls into the set-based default branch and
would send `carrom.game.summary`, which is not a carrom event type) — do not copy it.

## 5. generic
Cfg `packages/engine/src/sports/generic/generic.ts:30-40` — `resultMode` and
`allowDraws` have NO defaults (config must carry them); variants
`generic.ts:507-522`: `win_loss {resultMode:"win_loss",allowDraws:false,points{3,1,0},progressScore:false}`,
`score {resultMode:"score",allowDraws:true,...}`.
Events `generic.ts:50-70`:
```ts
export const GenericResult = z.strictObject({
  winnerId: EntrantId.optional(),
  p1Score: z.number().int().nonnegative().optional(),
  p2Score: z.number().int().nonnegative().optional(),
  isDraw: z.boolean().optional(),
});
export const GenericScore = z.strictObject({ by: EntrantId, points: z.number().int() /*≠0*/, person: z.string().min(1).optional() });
```
`p1Score` = HOME, `p2Score` = AWAY (`applyResult` `generic.ts:107-160`).
`generic.result` is accepted in phase `pre` OR `live` (`generic.ts:540-548`) — `core.start` optional.
Winner:
- win_loss: `{"type":"generic.result","payload":{"winnerId":"W"}}`
- score: `{"type":"generic.result","payload":{"p1Score":3,"p2Score":1}}` (`seed-demo.ts:347-354`)
Draw (needs `allowDraws:true`): win_loss `{"isDraw":true}`; score `{"p1Score":2,"p2Score":2}`;
otherwise `INVALID_EVENT "draws are not allowed in this division"`.
Abandon `generic.ts:565-570` ⇒ `no_result`. Forfeit `generic.ts:557-564` ⇒ `award`.

## 6–8. set-based: volleyball / badminton / tabletennis
Kernel cfg `packages/engine/src/sports/setbased/kernel.ts:83-110` (`bestOf` odd refine,
`setTo`, `finalSetTo`, `winBy`, `cap`, `pointsMap`, `records`).
Defaults: badminton `setbased/badminton.ts:21-38` (bo3, 21, win-by 2, cap 30, pointsMap `{"*":[2,0]}`;
variants `bwf`, `short` :39-42); tabletennis `setbased/tabletennis.ts:24-38` (bo5, 11, cap null;
variants `bo5`, `bo7`, `hardbat-21` :39-42); volleyball `setbased/volleyball.ts:32-43`
(bo5, 25, final 15, pointsMap FIVB `{"3-2":[2,1],"*":[3,0]}`; variants `indoor`, `beach` :44+).
Event types: `${key}.rally` and `${key}.${coarseEventType}` (`kernel.ts:1651-1656`);
coarse = `game.summary` (badminton :58, tabletennis :59), `set.summary` (volleyball :99).
Payloads `kernel.ts:153-209`:
```ts
export const SetBasedRally = z.strictObject({ wonBy: EntrantId, server?, scorer?, returns?, serving? });
export const SetSummaryPositional = z.strictObject({ home: int≥0, away: int≥0, partial: z.boolean().optional() });
export const SetSummaryByEntrant  = z.strictObject({ by: EntrantId, forBy: int≥0, forOpp: int≥0, partial?: boolean });
```
Summaries must be REACHABLE set scores (e.g. badminton 22-19 rejected, `testkit/scenarios.ts:150-175`).
`core.start` required (`kernel.ts:2329-2331`). Test helper `setbased.test.ts:35-41`.
Winner:
- badminton: `start, badminton.game.summary{home:21,away:15} ×2` (home) — seed-demo `seed-demo.ts:355-378`
- tabletennis: `start, tabletennis.game.summary{home:11,away:5} ×3`
- volleyball: `start, volleyball.set.summary{home:25,away:20} ×3` (`setbased.test.ts:103-106` uses 32-30,25-12,25-20)
Away wins: swap home/away. Rally form: `{type:"<key>.rally", payload:{wonBy:"W"}}` repeated.
Draw: impossible (odd bestOf refine).
Abandon `kernel.ts:818-823` ⇒ `phase:"abandoned"`, no outcome.

## 9. tennis (nested kernel)
Defaults `packages/engine/src/sports/tennis/tennis.ts:19-26`
(`bestOf:3`, `set {gamesTo:6,winBy:2,tiebreakAt:6,tiebreakTo:7}`, `finalSet:"same"`,
`game {noAd:false}`, `points {win:2,loss:0}`); variants `tennis.ts:27-44`
(`tour`, `grand-slam`, `fast4`, `doubles-noad-mtb10`).
Types `nested/kernel.ts:1822-1824`: `tennis.point`, `tennis.set_summary`, `tennis.game.award`.
```ts
export const NestedPoint = z.strictObject({ by: EntrantId, server?, scorer?, meta? });          // kernel.ts:229
export const NestedSetSummary = z.strictObject({                                             // kernel.ts:240
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  tb: z.strictObject({ home: int≥0, away: int≥0 }).optional(),
});
```
`core.start` required (`kernel.ts:2089-2091`). Winner (`seed-demo.ts:217-245`,
`nested/nested.test.ts:36-39, 155-160`):
```json
[{"type":"core.start","payload":{}},
 {"type":"tennis.set_summary","payload":{"home":6,"away":3}},
 {"type":"tennis.set_summary","payload":{"home":6,"away":4}}]
```
Tie-break set: `{"home":7,"away":6,"tb":{"home":7,"away":5}}`; 6-5 is NOT terminal.
MTB decider (`doubles-noad-mtb10`): third summary is raw points `{"home":10,"away":8}` (`nested.test.ts:184-188`).
Draw: impossible. Abandon `kernel.ts:1387-1392` ⇒ `abandoned`, no outcome.

## 10. icehockey (period kernel)
Defaults `packages/engine/src/sports/icehockey/icehockey.ts:165-177`
(`periods {count:3,minutes:20}`, `overtime {kind:"sudden_death",minutes:5,skaters:3}`,
`shootout {attempts:5,suddenDeath:true}`, `points {win:3,draw:1,loss:0,otWin:2,otLoss:1}`,
`awardScore {goals:5}`, `abandonPolicy:"replay"`); variants `:178-186` (`iihf: {}`,
`recreational: {overtime:null, shootout:null, points{2,1,0}, …}`).
Types `period/kernel.ts:1857-1866`: `icehockey.goal`, `icehockey.period.advance`,
`icehockey.shootout.attempt`, … Payloads `period/kernel.ts:229-256, 357+`:
```ts
export const PeriodGoal = z.strictObject({ by: EntrantId, person?, assists?: string[] (≤2), kind?, period?, emptyNet?, clockRef?, at? });
export const PeriodAdvance = z.strictObject({ to: z.string().min(1), at: GameTime.optional() });
export const PeriodShootoutAttempt = z.strictObject({ by: EntrantId, person?, scored: z.boolean(), goalkeeper?, void?, meta? });
```
`core.start` pushes P1 (`kernel.ts:2396-2398`). `to` MUST equal `expectedAdvance`
under a strict (live) write (`kernel.ts:1140-1152`, labels `:650-665, 998-1006`):
P1→"P2"→"P3"→"FT"; from OT the next is also "FT".
`resolveEnd` `kernel.ts:1032-1044`: leader wins; level after regulation → OT (if configured);
level after OT → SHOOTOUT (if configured); else `draw`.
Winner (`period/period.test.ts:69-75, 86-90`):
```json
[{"type":"core.start","payload":{}},
 {"type":"icehockey.goal","payload":{"by":"W"}},
 {"type":"icehockey.period.advance","payload":{"to":"P2"}},
 {"type":"icehockey.period.advance","payload":{"to":"P3"}},
 {"type":"icehockey.period.advance","payload":{"to":"FT"}}]
```
OT win: level at FT → phase `OT`; then `icehockey.goal {by:W}` ⇒ `win method:"extra_time"` (`period.test.ts:100-110`).
GWS: level, `advance FT` (→OT), `advance FT` (→SHOOTOUT), then alternate
`shootout.attempt {by, scored}` home-first; 3-0 decides after 6 (`period.test.ts:112-123`).
Draw: NOT reachable with default cfg; with variant `recreational` (overtime/shootout null)
a level FT ⇒ `draw` (INFERRED from `resolveEnd` `kernel.ts:1043`; no test pins icehockey draw).
Abandon `kernel.ts:1446-1461`: `replay` ⇒ undecided; `award` ⇒ leader `award`, level ⇒ `no_result`.

## 11. hockey (FIH, period kernel)
Defaults `packages/engine/src/sports/hockey/hockey.ts:125-136`
(`periods {count:4,minutes:15}`, `overtime:null`, `shootout:null`, `points 3/1/0`,
`goalKinds ["fg","pc","stroke","og"]`, `awardScore {goals:3}`, `abandonPolicy:"replay"`);
variants `:137+` (`fih-outdoor: {}`, `fih-shootout: {shootout:{attempts:5,suddenDeath:true,clockSeconds:8}, points{…shootoutWin:2,shootoutLoss:1}}`, …).
Types: `hockey.goal`, `hockey.period.advance`, `hockey.shootout.attempt` (same schemas as §10).
Winner (`period.test.ts:76-83`, `seed-demo.ts:318-345`):
```json
[{"type":"core.start","payload":{}},
 {"type":"hockey.goal","payload":{"by":"W"}},
 {"type":"hockey.period.advance","payload":{"to":"Q2"}},
 {"type":"hockey.period.advance","payload":{"to":"Q3"}},
 {"type":"hockey.period.advance","payload":{"to":"Q4"}},
 {"type":"hockey.period.advance","payload":{"to":"FT"}}]
```
Draw (default): same with no goals or level ⇒ `{kind:"draw"}` (`period.test.ts:92-94`).
Decider: variant `fih-shootout` — level FT goes straight to SHOOTOUT (`period.test.ts:155-162`).
Abandon: as §10.

## Quick-result endpoint
None. There is no quick/result route under `apps/web/src/app/api/v1/**`
(`git grep -i "quick.?result|resultEntry"` over server + api: empty). "Quick entry"
is sport-level coarse events on the same events endpoint:
`generic.result`, `boardgame.result`, `cricket.innings.summary`, `carrom.board.summary`,
`{volleyball.set|badminton.game|tabletennis.game}.summary`, `tennis.set_summary`.
Football / icehockey / hockey have no coarse result event — goals + period markers only.

## Harness cautions
- KNOCKOUT stages: engine draws are cfg-driven, not stage-driven. For football use
  cfg `{extraTime:{enabled:true,...}, shootout:true}` (or just avoid level scores);
  hockey `fih-shootout`; cricket `superOver:true`; generic `allowDraws:false`;
  carrom leave `tieBoard:"extra"`. What the app does with a `draw` outcome in a
  knockout fixture was NOT verified here.
- Always send `core.start` first (only generic can skip it; boardgame forfeit requires it).
- Period sports: `period.advance.to` must be the exact next label or the write 422s.
- Set-based/tennis summaries must be reachable scores under the cfg (win-by-2, cap).
