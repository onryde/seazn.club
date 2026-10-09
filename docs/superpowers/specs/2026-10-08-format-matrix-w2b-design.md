# Format matrix W2b — walkover, retirement and double-walkover credit (design)

- **Date:** 2026-10-08 · **Programme:** format × sport matrix, wave W2 (sport scoring fidelity), sub-wave **W2b**
- **Status:** design approved section by section in chat (session f-w2b, 2026-10-08); written spec **approved by the
  owner 2026-10-08** ("approve"), including §5.2's chess forfeit unification and boardgame `live` walkover phase. **No W2b product code until W2a (`feat/format-matrix-w2a`) has merged to main** (ruling 71; plan below §10).
- **Worktree / branch (spec only):** `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b-spec`,
  `docs/format-matrix-w2b-spec` (from `origin/main` `f61b12901`). Build branch: fresh `feat/format-matrix-w2b` off main
  after W2a merges.
- **Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`,
  `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` and `_INDEX.md`, the W2a design
  `docs/superpowers/specs/2026-10-08-format-matrix-w2a-design.md` (on `feat/format-matrix-w2a` until it merges), and the
  rulebooks `rulebook-W2-sets-cricket.md` (RB2A-n) and `rulebook-W2-goals-boards.md` (RB2B-n).
- **Code read at:** `feat/format-matrix-w2a` `1eb60c9ae` (W2a T0–T7 built; T8+ not yet) and W2a spec `f1d09f58d`.
  Every file:line below is from that branch. **Re-pin every line at plan time** — W2a is still building over this
  surface.

## 1. Why, and what done means

A match that is not played out — a no-show, a retirement, a disqualification, both sides absent, a withdrawal, an
abandon — today credits whatever happens to be in the ledger, and says "won by forfeit" for all of them.

Code read (scout, 2026-10-08):

- **The reason is free text.** `core.forfeit {by, reason: string}` (`packages/engine/src/core/events.ts:52`); the
  reason is copied verbatim into `award.method`. Walkover, retirement, DQ and withdrawal differ only by what an
  organiser typed (the console pre-fills `"walkover"`, `fixture-console.tsx` `ForfeitButton`). The public match centre
  reads every `award` as "{winner} won by forfeit" (`apps/web/src/server/public-site/match-centre.ts:742`).
- **Walkover credit is uneven.** Football and the period kernel overwrite the score with `awardScore` (3-0; ice hockey
  5-0) even when the offender was losing by more (`football.ts:1636-1651`, `period/kernel.ts:1430-1445`). Set sports
  and tennis credit match points but only the sets/games actually played (`setbased/kernel.ts:2260-2265`,
  `nested/kernel.ts:2197-2215`). Cricket zeroes both NRR ledgers (`cricket.ts:3913-3919`). Carrom keeps only boards
  played (`carrom.ts:953-960`).
- **A retirement is a walkover.** Same event, same credit; a retiree can finish ahead on ratio (SC-S4).
- **A double walkover exists only in chess**, as `boardgame.result{method:"double_forfeit"}` → `no_result`: 0 points,
  played +1, no W/D/L (`boardgame.ts:292-296, 850-855`). In W2a it is held `needs_decision` in a bracket and closed by
  settle (T15-R1), so one of two absent players advances. Every other sport cannot record one (SC-S6).
- **An abandoned match never reaches a table**, even with a result: `fixtureStatusFromFold` returns `abandoned` for any
  active abandon (`append-event.ts:143-161`), which maps to `void` (`apps/web/src/lib/fixture-engine-status.ts`), and
  tables count only `decided`/`walkover` (`packages/engine/src/competition/stage.ts:24`). A cricket DLS win and a rain
  no-result score nothing (ST-G1, high, confirmed live in W1b).
- **Withdrawal holes.** A held (`needs_decision`) fixture is skipped (C17); page_playoff and ladder void instead of
  walking over (`stages.ts:880-884`); chess refuses a forfeit before start (`boardgame.ts:711`), so a chess withdrawal
  can throw partway (CD-T13); a fixture with a TBD opponent gets an abandon the append refuses (`append-event.ts:200`,
  inferred, not run).

**Owner value:** for every sport and every way a match goes unplayed or unfinished, the table, the bracket, player
stats and the public page credit what the federation says and say plainly what happened. No absent side ever advances,
and no organiser has to fake a walkover to move a draw on.

**Done means:**

1. Every row in Appendix A is signed, enforced, and proved by a test whose title carries its id.
2. The W2b reds (§8) were reproduced before their fix and are green after it; the judge regression shows 0 new reds.
3. The reference families (`walkover-credit`, extended `bracket-finish`), written by a different agent from the
   engine fixer, agree with the engine on every case they enumerate, and each reports its count.
4. UI screens pass per-screen screenshot verdicts at 1280, 768 and 320.

## 2. Scope

### 2.1 In W2b (W2b-R1)

1. A closed reason vocabulary: walkover, retired, disqualified, withdrew. Translated; public "w/o" / "ret." / "DQ".
2. Walkover credit per sport: RB2A-4, RB2B-6 (real score upheld if worse; hockey default 3 → 5), RB2B-24, RB2B-29
   (engine half), RB2A-21 (cricket NRR).
3. Retirement credit per sport (RB2A-5), and in-match DQ at the same credit.
4. Double walkover in all 11 sports, in tables and brackets (RB2A-6, RB2B-15). Resolves T15-R1 and amends X-BR-1.
5. RB2A-31: the walkover-after-abandon refusal (deferred to W2b by ruling 72).
6. Withdrawal: C17 auto-walkover of a held fixture, chess forfeit before start (RB2B-21, CD-T13's W2 half),
   page_playoff/ladder walk over, TBD-opponent seat, both sides withdrawn.
7. ST-G1: an abandon that produced a result counts in the table (with RB2A-19, RB2B-13, RB2B-25, RB2B-33).
8. Player stats for unplayed and stopped matches.

### 2.2 Out, each with its owner

| Item | Owner | Why there |
|---|---|---|
| RB2A-3 badminton "delete all results" (GCR 16.2.5) replacing 50%; TT-13; ST-G15 | W5 | Roster/withdrawal-cascade policy. Badminton keeps 50% meanwhile as a recorded **deviation** (BD-WO-2, BD-RT-1). |
| RB2A-16 DQ cascade to other fixtures | W5 | Same surface. W2b gives in-match DQ its credit only (X-RT-1). |
| RB2A-7 / TT-5 table tennis 2/1/0 | W2d | Table-points system. |
| ST-G8 stage PointsRule screen; RB2B-29 stage-level awarded score; opt-in shared points on abandon (RB2B-25); H-15 hockey Q4 "score stands" | W2c | Stage-level settings with a screen. |
| Sanction/short-team endings (tennis default, badminton DQ, volleyball incomplete team, hockey below `strength.min`, M12b) | W2e | Sport mechanics; W2b supplies the credit they will use. |
| Swiss: double walkover "not met" and bye-eligible (RB3-14, SW-M9), forfeits unplayed in Buchholz/SB (SW-L1) | W3 | W2b owns the outcome; W3 wires Swiss. |
| RB2B-34 refuse bulk retroactive forfeit | W9 | Operational bulk action. |
| A vacant title or third place after a double walkover in a final | W4 | With joint winners (RB2A-30); needs the final-ranks reader. **Handover**, W2b-R10. |
| "Void last" offered after a forfeit (W1d observation) | Pad programme | Pad defect, noted only. |
| A "replay from 0-0" reset for an abandoned match | unowned — gap | No wave has it; recorded so it is not assumed. |
| Second `core.finalize` accepted by 10 of 11 modules | W2a open owner question | Not W2b's; the W2a pin stays. |

## 3. Rulings this spec implements

Signed by the owner in session f-w2b, 2026-10-08. Numbered **W2b-Rn** here; folded into `_INDEX.md` after W2a merges,
numbered after W2a's last ruling (82 at the time of writing; W2a may add more during its build — take the next free
number then). `_INDEX.md` is not edited before W2a merges (rule 18).

| Id | Ruling | Owner said |
|---|---|---|
| W2b-R1 | Scope as §2.1 / §2.2. | "ok" |
| W2b-R2 | Double walkover = new outcome kind `double_walkover`: both lose, nobody advances; every seat it feeds is dead and that seat's opponent walks over; DE: neither drops to the losers' bracket; third-place feed won by walkover by the other semi-final loser; X-BR-1 amended to "a win or a double walkover"; not level, so never held or settleable; chess `double_forfeit` folds to it in every stage kind (retires T15-R1). Checked with session f-w2 (no clash, §12). | "OK, A but check and brainstorm with f-w2" |
| W2b-R3 | Double walkover in a table: P+1, L+1, 0 points, no score credited, excluded from every ratio. | "A" |
| W2b-R4 | Walkover credit per sport (Appendix A `*-WO-*`), derived from the stage cfg, one credited score everywhere. Badminton groups: 2-0 ×21-0 as a deviation until W5. | "Ok" |
| W2b-R5 | Retirement credit per sport (`*-RT-*`); goal sports keep the real score if worse for the offender; in-match DQ = retirement credit. | "Ok" |
| W2b-R6 | Abandon counts in a table only when the sport's rule gives a result (cricket DLS / NR 1 point; goal sports under award policy: leader wins, level = draw); carrom and generic abandon → replay; status follows the result; auto-advance treats it as finished; **no backfill**. | "Ok" |
| W2b-R7 | Forfeit while an abandon is active is refused `ABANDONED_SETTLE_OR_VOID` with guidance; void-then-forfeit stays, credited as a retirement. | "A" |
| W2b-R8 | Withdrawal: held fixture → auto-walkover to the remaining side (answers C17); chess pre-start forfeit; page_playoff/ladder walk over; TBD seat → dead seat (reproduce first); both withdrawn → double walkover (final stays open). | "ok" |
| W2b-R9 | Player stats: walkover/withdrew/double walkover are not a match and credit no personal W/L; retired/DQ/abandon-with-result count. Settled matches unchanged (D-C6, D-C3). | "ok" |
| W2b-R10 | Double walkover refused in a final, last rung or third-place match; fixture stays open; guidance copy; vacant title → W4. | "a" |
| W2b-R11 | Double elimination: any forfeit loser is out (no losers'-bracket drop); ranks reader aligned with seating. | "a" |
| W2b-UI-1 | Console: one dialog — who (Home / Away / Neither) → why (chips by phase) → credit preview → one specific Confirm. Wireframe in `.superpowers/brainstorm/51672-1791493602/content/forfeit-dialog.html` (gitignored; flow only). | "A" (against the session's recommendation B) |
| W2b-UI-2 | Public: short tag where space is tight (`w/o`, `ret.`, `DQ`, `2× w/o`, `Aband. · DLS`, `Aband. · NR`; per locale), the full sentence as tooltip and accessible name and in the match centre. Wireframe `public-copy.html`. | "A" |
| W2b-R12 | Legacy stages already complete that hold a V432-moved fixture: no reopen path; pre-ship count on staging and prod, stop and ask if non-zero (W2a item 5). | "A" |
| W2b-R13 | `division_has_results` (quota slot) counts only results with a verdict: excludes `no_result` and `double_walkover` whatever the status; single walkover still counts. | "A" |
| W2b-R14 | Chess tie-break pending (classical drawn, decider not played): a withdrawal walks the fixture over to the remaining side (`core.forfeit{reason:"withdrew"}` accepted in phase `tiebreak`), and an organiser may record a walkover when a player does not turn up for the tie-break games; the classical game stays a draw in stats (D-C6). Replaces W2a's interim hold (D-R1) and the pinned WRONG_PHASE forfeit in `tiebreak`. | "A" |
| W2b-A1 | Approach 1: extend `core.forfeit`; strict schema, no legacy free-text mapping (owner: "we don't have any forfeit old data") — verified before ship (§5.4). | "1" |

Wireframes are for flow and structure only (W2a owner ruling, 2026-10-08): the build applies house UI — v2
components, `btn` classes and tokens, the existing dialog pattern, the pad v3 skin and the phone composition spec.

## 4. Architecture (approach 1)

One event carries every unplayed or stopped result; each sport declares what it is worth; every reader reads that
declaration.

```
core.forfeit {by: entrant | "both", reason}
   │  kernel: phase guard, abandon guard
   ▼
sport fold ──► outcome: award{winner, loser, reason} | double_walkover
   │                          │
   │      forfeitCredit(cfg, state, reason, by)   ◄── one hook per sport (lookup, like bracketDeciders)
   ▼                          ▼
standingsDelta / tie-break ratios / public copy / qualification view / console preview
   │
   ▼
competition: advancingSides · bracketWinnerLoser · feederIsDead + advancesNobody · completeTableStage
   │
   ▼
server: fixtureStatusFromFold · append guards · withdrawal cascade · migration
```

Rejected: separate `core.walkover` / `core.retire` / `core.double_walkover` events (three kernel types to gate, skip
in replay loops and teach every consumer; two ways to say one thing); structuring reasons in apps/web only (the credit
rules would live outside the engine, against ruling 75 and the engine split).

## 5. Components

### 5.1 Engine core (`packages/engine/src/core/`)

- **Event.** `CoreForfeit = {by: EntrantId | "both", reason: "walkover" | "retired" | "disqualified" | "withdrew"}`,
  strict. `forfeitOf()` returns the typed pair; every caller is enumerated (`grep -a`) and updated.
- **Phase guard (kernel, before the module fold).** `walkover` (one side or `"both"`): only in the module's declared
  walkover phases — `pre` for every sport, plus `live` for boardgame, where a no-show is a forfeit after the session
  starts (FIDE Laws Art. 6.7.1) and the pad's dock already lives in `live` (D-P1). `"both"` is only ever a walkover.
  `retired`, `disqualified`: only after `core.start`. Boardgame also accepts `withdrew` and `walkover` (one side) in
  phase `tiebreak` (W2b-R14); `"both"` there is refused — the classical game was played. `withdrew`: either (written only by the withdrawal cascade). Refusal:
  `FORFEIT_REASON_WRONG_PHASE` with the phase. The module's own phase guards stay for done/final.
- **Abandon guard.** A forfeit while an unvoided `core.abandon` is active → `ABANDONED_SETTLE_OR_VOID` (W2b-R7). Today
  the module phase guards refuse it incidentally ("already over"); the named refusal replaces that message.
- **Outcome kinds** (`types.ts:134-158`). The set becomes `win | draw | tie | no_result | award | double_walkover`.
  `award` = `{winner, loser, reason}` (the free-text `method` and optional `score` are removed; the credited score comes
  from the hook). `double_walkover` = `{kind}` — the sides are the fixture's two entrants. **The first W2b test pins the
  set** (none does today). `isLevelOutcome` is unchanged — `double_walkover` must not be level, or it becomes held and
  settleable.
- **`advancesNobody(outcome)`** — new kernel predicate, true for `double_walkover` only. One authority; every bracket
  reader asks it.
- **`outcomeOf`** — returns `double_walkover` as folded; settlement still wins over it only where `settleApplies`,
  which is false for it.
- **Kernel-owned / gate.** `core.forfeit` is already in W2a's X-ST-2 organiser predicate (type + payload, D-O1); the
  chess `boardgame.result{forfeit | double_forfeit}` entries stay in it. No new event type, so no new replay-skip.

### 5.2 Sport modules (`packages/engine/src/sports/`)

Each module implements `forfeitCredit(cfg, state, reason, by) → {perSide: credited score/metrics, excluded: ratio
keys}`, and its `standingsDelta` reads it for `award` (instead of the played ledger) and handles `double_walkover`
explicitly: both `played 1, lost 1, points 0`, no metrics, every ratio excluded (X-DW-4). Values are computed from cfg
(best-of, target score, overs, `awardScore`), never literals.

| Module | Walkover | Retirement / in-match DQ | Double walkover | Abandon change |
|---|---|---|---|---|
| football | `awardScore` 3-0 | max(awarded, real) by the offender's margin (stop overwriting, `football.ts:1640-1644`) | new | award policy: level → `draw` with real score |
| hockey (period, preset `hockey.ts:134`) | `awardScore` **5-0** (default 3 → 5) | as football (`period/kernel.ts:1429-1444`) | new | as football |
| icehockey (period) | 5-0 | as football | new | as football |
| volleyball (setbased) | sets-to-win × 25-0 | winner given the sets/points needed; retiree keeps its own | new (replaces the throw, `setbased:2439`) | — |
| tabletennis (setbased) | games-to-win × 11-0 | played points stand; current game completed for winner; rest 11-0 | new | — |
| badminton (setbased) | 2-0 × 21-0 (groups: deviation) | as TT, to 21 (deviation) | new | — |
| tennis (nested) | straight sets for set %; match games excluded from game % | same | new (replaces the throw, `nested:2207`) | — |
| cricket | full points; defaulter charged full quota at 0 runs (no zeroed ledgers, `cricket.ts:3913-3919`) | refusal to continue = forfeit = walkover credit | new | DLS result / NR now reach the table via status (§5.4) |
| boardgame | 1-0 as today, now also before start (`boardgame.ts:711`) | resign = loss; post-start forfeit 1-0 | `double_forfeit` → `double_walkover` (`:292-296`); rewrite `standingsDelta :850-855` | — |
| carrom | games-to-win × 25-0 | completed stand; unfinished 25–(opponent); rest 25-0 | new (replaces the throw, `carrom:941`) | abandon → replay, outcome null (`:467-472`) |
| generic | win points, 0-0 | walkover credit, keeping recorded score | new | abandon → replay, outcome null (`generic.ts:570-575`) |

**Chess forfeit paths — decision raised at spec review.** Chess has two single-forfeit paths today:
`core.forfeit` → `win{method:"forfeit"}` with the reason dropped on purpose (`boardgame.ts:710-723`), and the pad
dock's `boardgame.result{method:"forfeit"}` (`skins/boardgame.tsx:148-165`), which gives status `decided` instead of
`forfeited` — two statuses for one fact. Spec position: both unify on `core.forfeit` → `award{winner, loser, reason}`
like the other ten sports, so the reason, credit, stats skip and public tag work identically; `forfeited: true` (colour
history excluded) stays; the dock's forfeit tile sends `core.forfeit` with the reason chips of UI-1; the dock's
double-forfeit tile sends `core.forfeit{by:"both", reason:"walkover"}`. `boardgame.result{forfeit | double_forfeit}`
then stays accepted by the schema only for streams written before W2b (none expected — §5.4's count covers it) and
is no longer emitted. Owner confirmed with the spec approval (2026-10-08).

**Schema tightening (f-w2, W2a loop F review).** `BoardgameResult` (`boardgame.ts:140`) does not tie `winner` to
`method`, so `{winner:"H", method:"double_forfeit"}` parses today. W2b's schema refuses it (`double_forfeit` ⇒ `winner`
null; `forfeit` ⇒ `winner` present), and the write path refuses both forfeit methods once the dock sends
`core.forfeit`. W2a is adjusting its D-O1 derivation test so this tightening does not red it; W2a's gate keeps the
`boardgame.result` entries as a defensive no-op.

Compile-time: football `:2623`, cricket `:3910`, period `:2616`, generic `:624` and `:212` have no `default` — the new
kind becomes a compile error there, by design. Runtime throws at setbased `:2439`, nested `:2207`, carrom `:941`,
boardgame `:807` get explicit cases.

**Player-stat folds (W2b-R9).** Each sport's `playerStats.folded.fold` skips `award` with reason walkover/withdrew and
`double_walkover` (no W/L, not a match); keeps retired/disqualified. The eight `outcomeOf` readers each gain the case;
the reader-count pin (`outcome-readers.test.ts`) does not grow.

### 5.3 Competition (`packages/engine/src/competition/`, `apps/web/src/server/engine-db/`)

- `advancingSides` (`fed-seats.ts:97-103`) and `bracketWinnerLoser` (`competition.ts:153-165`): exhaustive switches;
  `double_walkover` → no sides; `award` → winner advances, typed `loser` is never seated on a loser edge, and ranks
  read the same answer (W2b-R11; the readers disagree today).
- `feederIsDead` (`stages.ts:3657`) and `loserFeederIsDead` (`:3688-3695`) each gain one **separate** clause: the
  feeder is decided and `advancesNobody(outcome)`. It sits beside W2a's `has_active_abandon` distinction (T10,
  `335a24807`: a recorded abandon is not dead, only a generator void or a voided abandon cascades), never inside it.
  W2a's follow-up applies the same distinction to stage completion and ranking (an abandoned final completes the stage
  today) — re-read it before planning. W2a's NEW-H1 split (scorer abandon vs generator void, Task 10) is
  not touched. Without the clause the fed seat waits forever, silently (f-w2 Q3).
- **No next match.** A double walkover on a fixture that feeds no seat — final, last rung, third-place match — is
  refused `DOUBLE_WALKOVER_NO_NEXT_MATCH`, derived from the stage's feed graph, never from round names.
- `completeTableStage`: `double_walkover` fixtures count (status §5.4). `PointsRule.forfeit` keeps overriding points;
  its `awardScore` overrides the hook's score only where a stage sets it explicitly.
- Tie-break readers honour the hook's `excluded` keys (set %, game %, NRR, goal ratios). Swiss Buchholz/SB unchanged
  (W3).
- Auto-advance (`scoring.ts:826-830`) treats `decided` abandons with a result and `forfeited` double walkovers as
  finished (RB2B-33). It also treats `finalized` as open today — **reproduce, then fix inline**.

### 5.4 Server and data (`apps/web/src/server/`)

- **`fixtureStatusFromFold`** (`append-event.ts:143-161`), new order: settled → `decided`; active abandon **and null
  outcome** → `abandoned`; level in a bracket → `needs_decision`; `double_walkover` or `award` → `forfeited`; any other
  outcome → `decided` (this is ST-G1's fix). The "Abandoned — …" label on surfaces reads the ledger (active
  `core.abandon` + its reason), not the status. Stored statuses are not recomputed (no backfill, X-AB-3).
- **Append guards.** Strict `core.forfeit` schema → `INVALID_PAYLOAD`. `DOUBLE_WALKOVER_NO_NEXT_MATCH` is checked
  server-side, where the feed graph is known. The organiser gate is W2a's.
- **Withdrawal cascade** (`withdrawal.ts:130-232`, `competition/stage.ts:412-472`): reason `"withdrew"` (the English
  `"entrant withdrew"`, `withdrawal.ts:42`, goes); `needs_decision` fixtures walk over to the remaining side instead of
  being skipped as settled (`withdrawal.ts:195`); page_playoff and ladder join the walk-over kinds (`stages.ts:880-884`);
  a seat whose opponent is TBD is reproduced first and, if the throw is real, marked dead so the arriving opponent
  advances by walkover; (W2a's fix round names `needs_decision` explicitly at `withdrawal.ts:192-201`, reviewer M-7 — build on that, not
  on today's lines); a fixture whose other side has already withdrawn becomes a double walkover (final: stays open);
  a not-started chess fixture gets a pre-start forfeit.
- **Withdrawal corners deferred by W2a (ruling D-G2, `8d9255d96`; each pinned in W2a as a named characterisation
  test that W2b rewrites deliberately):**
  1. *Withdrawal from an abandoned, unsettled bracket fixture* (an active `core.abandon`, null outcome — after NEW-H1,
     `335a24807`, it is not a dead feeder and must be settled). Under W2b-R8 it is treated like a held fixture: the
     cascade voids the abandon and records `core.forfeit{by: withdrawn, reason: "withdrew"}` (the void-then-forfeit
     path W2b-R7 keeps open; retirement credit, the pre-abandon score stands). So when both entrants of that line
     withdraw in turn, the first withdrawal walks it over to the second, whose own withdrawal then walks over its NEXT
     fixture — the fed opponent advances, and no settle is ever asked to name a withdrawn entrant (C17 stays intact).
  2. *A settle seats a withdrawn loser on a loser edge* (page_playoff q2, knockout third place, double_elim). X-WD-1
     removes the ordinary path (a held fixture is walked over at withdrawal, so no settle follows). As a guard, not a
     comment: seating a withdrawn entrant on any loser edge is refused at the seating callers and the seat is treated
     as dead, so its opponent walks over (X-WD-5).
- **Two more corners deferred by W2a (ruling D-G3; pinned in W2a):**
  3. *A stepladder qualifier departs before the draw* → `completeStage` refuses `CONFIG_INVALID` with generic copy;
     today's escape is `core.start` + `core.forfeit` by the departed seed. W2b: the departed seed's seat is dead
     (X-WD-3), so its rung opponent advances by walkover with no organiser step; where a seat still cannot be
     resolved, the refusal is named (`STAGE_SEAT_DEPARTED`, 409, organiser copy in 4 locales naming the entrant and
     the fixture) instead of `CONFIG_INVALID`.
  4. *A ladder withdrawal's recorded abandon on a pending challenge holds ladder completion until settled.* Under
     X-WD-2 the ladder cascade writes `core.forfeit{reason:"withdrew"}`, never an abandon, so the hold does not arise;
     the W2a pin is rewritten to that.

  W2a interface (loop G, `cea1a52c8`): `apps/web/src/server/engine-db/recorded-abandon.ts` is the single status-gated
  source for "a recorded abandon"; the seat resolver and `loadStageInputs` read it; in bracket and ladder completion an
  active abandon with a null or level outcome reads `in_play` (tables still read `void`, because withdrawal expunge
  writes a recorded abandon there); `abandonAwaitsSettle` equals `settleApplies` for abandoned rows; `bracketRanks`
  refuses an in-field entrant ranked −1 (`CONFIG_INVALID`). W2b's ST-G1 status change (§5.4) must agree with this
  source — `double_walkover` and abandon-with-result go through it, not around it.
- **Migration** (next free version after W2a's V432): re-classify **unsettled** `needs_decision` bracket rows whose
  active result is `boardgame.result{double_forfeit}` to `forfeited` + `double_walkover`, then run the dead-seat
  cascade for each. Settled rows are untouched. The migration reports examined and changed counts; its test fails on
  zero examined (it seeds the row it expects). Prod count is probably 0.
- **Billing: `division_has_results` (W2b-R13).** The quota-slot predicate (V355; W2a D-F4 for held `no_result`)
  counts a fixture by status. W2b's statuses would silently move it: a cricket rain no-result becomes `decided` (R6)
  and a double walkover `forfeited`. A W2b delta redefines it to exclude outcome kinds `no_result` and
  `double_walkover` whatever the status; a single walkover still counts (as today). One test per outcome kind × status,
  including a positive pair for each exclusion; reads in `division-slots.ts` and `admin-divisions.ts` keep calling the
  SQL function, never a TypeScript copy. Rebase on W2a's final definition (D-F4) before writing the delta.
- **Legacy completed stages holding a fixture (W2b-R12).** A stage already marked complete keeps `stages.status`
  when W2a's V432 moves one of its fixtures to `needs_decision` (stored flag, `competition.ts:679`, early return
  `:580`); W2a's V432 notice counts them (`complete_stages_holding_one`). W2b builds no reopen path: before ship, read
  that count on staging and prod; 0 → nothing; non-zero → stop and bring the owner the actual rows.
- **Pre-ship check (W2b-A1).** Before the strict schema ships, count `core.forfeit` events in staging and prod
  (`list_projects` first). Non-zero → stop and ask the owner; do not ship a schema that cannot read stored events.

### 5.5 App UI (`apps/web/src/components/`)

- **Console** (`v2/fixture-console.tsx`): `ForfeitButton` + its `TextPromptDialog` are replaced by one dialog (UI-1,
  existing v2 dialog pattern): who → why → credit preview → Confirm ("Record walkover", "Record retirement", "Record
  double walkover", "Record disqualification"). "Neither" only in the sport's walkover phases, hidden where refused (R10 guidance shown
  instead). The preview calls the same `forfeitCredit` the engine exports. The console's `decided` (`:800`) becomes
  outcome present, or status abandoned with a null outcome.
- **Pad.** The chess dock's forfeit / double forfeit are organiser-only through W2a's shared predicate; the
  double-forfeit tile records a double walkover. Ribbon, ledger and timeline copy (`lib/event-copy.ts:110-116`,
  `scorepad/v3/ribbon.ts:111`, `lib/scoring-vocab.ts:82, 543`) speak the four reasons and the double walkover.
- **Public** (UI-2): tags in results lists, bracket tiles (`public-site/matches-hub/knockout-tab.tsx`), live-score
  chips (`public-site/live-score.tsx:90-95`), the division result line (`v2/stages-panel.tsx:1996`); the match-centre
  sentence replaces "won by forfeit" (`server/public-site/match-centre.ts:742`); qualification view reads the hook
  (`qualification-view.ts:98-107`).
- **Held chess double forfeits on public pages.** Until W2b, W2a holds a bracket chess double forfeit as `no_result`
  and the public site reads "Level — winner to be decided" although nobody played (W2a whole-branch review). W2b's
  fold and migration (§5.4) turn every such fixture into a `double_walkover`, which renders with UI-2's double-walkover
  tag and sentence; a test asserts no fixture whose active result is a chess double forfeit renders the "Level"
  copy after the migration.
- **Copy.** Every new string in all 4 dictionaries, then `gen-keys`; abbreviations per locale; no English fallback.

### 5.6 Harness (`tools/matrix/`) and reference model (`packages/reference/`)

- **Generator breadth first** (checklist §4): partial-score retirement in every sport; double walkover in every sport
  × every stage kind incl. final / last rung / third place; walkover before start and forfeit after; award-policy
  abandon level and leading; withdrawal cascades (held, TBD, both withdrawn, chess not started).
- **Model:** `Forfeit{by | both, reason}` command; `toObservedOutcome` (`observed.ts:161-169`) learns
  `double_walkover` (it returns null today — the fixture would read undecided); harness M7 mapping rewritten.
- **Reference** (written by a different agent from the engine fixer, R8): new family `walkover-credit` (11 sports × 4
  reasons: credited score, ratio exclusions, points, stats), oracle from Appendix A and the rulebooks, never from the
  engine; `bracket-finish` (`LEVEL_KINDS`/`PlayResult`/`WinMethod`, `:24-42`) extended independently for
  `double_walkover` and dead seats. Each states its empty case first and reports its count.

## 6. The rules reference

Appendix A lists the 54 rows (23 cross-sport, 31 per sport) to add at build; 7 new sport files (football, hockey,
icehockey, volleyball, badminton, tabletennis, tennis). Ids are new and unique against the W2a seed (X-BR-1, X-BR-2,
X-ST-1, X-ST-2, X-DR-1, BG-KO-1, BG-KO-2, CA-KO-1, CK-KO-1, GN-KO-1). X-BR-1's text is amended (W2b-R2), not
renumbered. Each signed or deviation row ships with a proving test whose title contains its id
(`rules-reference.test.ts` enforces this).

## 7. Error handling

| Code | HTTP | When | Copy (4 locales) |
|---|---|---|---|
| `FORFEIT_REASON_WRONG_PHASE` | 409 | walkover / both after start; retired / disqualified before start | Names the phase and the reasons it allows. |
| `ABANDONED_SETTLE_OR_VOID` | 409 | forfeit while an abandon is active | "This match was abandoned. To decide it, settle the match. If it is being replayed, void the abandon first." |
| `DOUBLE_WALKOVER_NO_NEXT_MATCH` | 409 | double walkover on a fixture that feeds no seat | "A final needs a result. Reschedule it, or record a walkover if one side turned up. If the competition must close without a match, settle it." |
| `STAGE_SEAT_DEPARTED` | 409 | a bracket/stepladder seat whose entrant departed cannot be resolved to a walkover | Names the entrant and the fixture; tells the organiser which match to record. |
| `INVALID_PAYLOAD` | 400 | free-text or unknown reason | existing |

## 8. Truth run and proof

1. Generators (§5.6) land first.
2. **Reproduce before fix:** ST-G1 (cricket DLS / NR, award-policy abandon), SC-S3 (walkover credit), SC-S4
   (retirement credit), SC-S6 (no double walkover), F-16 / H-14 / I-16 (score overwritten), H-13 (hockey 3-0), B-7
   (chess pre-start), B-9 / B-10 (chess double forfeit), C-6 (carrom), CR-2 / CR-10 (cricket NR, NRR), the C17 held
   fixture, page_playoff/ladder void, the TBD-seat throw, the chess-not-started throw, the DE ranks/seating disagreement,
   auto-advance on `finalized`. Each red is recorded with its case id before the fix.
   **Inherited reds from W2a (ruling D-P2):** 5 boardgame L3 cells on scenario R4 — knockout,
   knockout_third_place, double_elim, ko_plate, qualifying_main — re-keyed SC-O1 → CD-T13 and pinned in W2a's judge
   with their reason string (`withdrawal.ts:125-130` posts a bare `core.forfeit` on an unstarted chess fixture;
   `boardgame.ts:711` refuses WRONG_PHASE). BG-WO-2 + the W2b reason rules turn them green; W2b then unpins them
   (pin names come with W2a's merge notice). Not W2b's: boardgame ko_plate F1 → FX-G14 (W4).
   **Same 422 in Swiss** (chess session, via f-w2, 2026-10-09): every withdrawal branch converges on `applyUpdate`
   (`withdrawal.ts:115`, call `:242`), so a Swiss chess withdrawal on an unstarted board fails too; no test pins it
   (`swiss-withdrawal-walkover.test.ts:80` is badminton). Reproduce with a chess copy of that test. Line pins here are
   at W2a `a36c1dcf2` (`boardgame.ts:711`, `withdrawal.ts:129`); a reader citing `:617` / `:108-112` was on another
   revision — re-pin at plan time.
   **External caller:** the chess programme's no-show sweep (T+20, player never seated) posts a forfeit on a fixture
   that never began (phase `pre`) every round; BG-WO-2's `pre` acceptance is its contract.
3. Fix → the W2b rows green locally (scoped: W2b cases only).
4. One judge regression dispatched on CI (`matrix:judge regression`) → 0 new reds, including W3–W7 cells.
5. `MATRIX.md` regenerated.

## 9. Testing and gates

- **All 4 test types per task** (unit, e2e, smoke, regression), house rules in `TEST-STRATEGY.md`.
- **Anti-vacuity:** every sweep, property and invariant reports how many items it checked; zero is a failure.
- **Sweeps enumerate from engine declarations:** 11 sports × 4 reasons × {before, after start} × 9 stage kinds; the
  phase-guard sweep asserts each refusal and each acceptance.
- **Expected values** from Appendix A / the rulebooks, never from the code under test; at least one case per sport
  where the right credit differs from the old constant (e.g. football 0-5 retirement stays 0-5, not 0-3; hockey 5-0
  not 3-0; 3-set volleyball credits 2-0).
- **Sequence tests (rule 10, fast-check):** forfeit after abandon; void then forfeit; double walkover then void;
  withdraw before and after start; a second forfeit; withdraw both sides in turn.
- **Mutation:** each new guard mutated once by hand (phase guard, abandon guard, `advancesNobody`, the two dead-seat
  clauses, no-next-match, the migration selection); Stryker probe + touched families dispatched before merge; floors
  never auto-raised.
- **Pins to rewrite (from f-w2):** `needs-decision-status.test.ts:43`, the V432 migration test, the reference HELD
  table, BG-KO-1, `tiebreak.test.ts:46/:50`, harness M7, the D-G2 and D-G3 characterisation pins (§5.4), W2a's "forfeit refused in phase `tiebreak`" pin and its D-R1 withdrawal-hold pin (W2b-R14), and W2a's D-O1 gate derivation test (it assumes
  `boardgame.result{double_forfeit}` is still written). Each rewrite says why in its commit.
- **UI:** screenshot verdicts per screen at 1280 / 768 / 320 (console dialog before and after play and the final
  guidance; match centre; results list; bracket tile), no horizontal scroll; the whole `mobile.spec.ts`, never a `-g`
  slice; every e2e asserting the old forfeit testids found with `grep -a` and made to open the new dialog.
- **Local runs are scoped** to the files changed; the full suite is CI's.

## 10. Delivery

1. This spec merges as docs (or rides on the build branch) — no product code before W2a merges.
2. After W2a merges: fresh worktree `feat/format-matrix-w2b` off main; re-pin every file:line in this spec; plan via
   writing-plans; owner approves the plan and picks execution.
3. Fold W2b rulings into `_INDEX.md` (next free numbers after W2a's last), with "False premises found (W2b)" (§13) and
   the RBB §8 gap ids (F-16/H-14/I-16, H-13, H-15, B-7, B-9, C-6, C-8/G-7) registered.
4. Rows into `packages/engine/rules/`; statuses rewritten to the ruling numbers.
5. One PR, merge commit; e2e via `workflow_dispatch --ref feat/format-matrix-w2b`; smoke on the PR; Stryker families
   dispatched; whole-branch review before merge.
6. Models and effort per `RULES.md` and `.claude/agents/*.md`; no per-dispatch override unless the owner rules one.

## 11. Risks

- **W2a moves under this spec.** It is mid-build over the same files. Mitigation: f-w2 notifies interface moves (one
  so far: X-ST-2 → type + payload, D-O1, `f1d09f58d`); every line re-pinned at plan time.
- **Strict schema vs stored events.** Mitigated by the pre-ship count (§5.4).
- **Prod behaviour changes for live stages:** hockey walkover 3 → 5; carrom/generic abandon no longer share points;
  football/period award-policy level abandon becomes a draw; cricket abandons start counting. Low volume before
  2026-10-31; no backfill keeps history as it was.
- **A sixth outcome kind reaches many readers.** Mitigation: exhaustive switches turn misses into compile errors;
  the pinned kind set; the f-w2 46-row seam table
  (`.superpowers/w2b-brainstorm/f-w2-scout-w2b-outcome-set.md`, gitignored) is the checklist for the plan.
- **Badminton deviation.** BD-WO-2 / BD-RT-1 knowingly differ from GCR 16.2.5 until W5.

## 12. W2a dependencies and coordination

Designed against W2a's settled interfaces: `needs_decision`; `core.settle` + `settleApplies` / `deciderPending`;
kernel-owned events; the four §7 codes; the P2-7 finalize guard; C17's settle refusal; X-ST-2 as type + payload (D-O1).

Checked with session f-w2 (2026-10-08): **no clash with W2a's build; Option A sound.** Its four musts are in this spec:
do not add `double_walkover` to `isLevelOutcome` (§5.1); make "nobody advances" explicit in the seat readers (§5.3);
`advancesNobody` as a separate clause in both dead-seat predicates (§5.3); migrate unsettled held chess double
forfeits and leave settled rows (§5.4). W2b changes X-BR-1's wording and retires T15-R1 only after W2a merges; nothing
in W2a's build moves. Any further W2a interface change comes only through f-w2's owner.

Raised by f-w2 from W2a's loop F review (2026-10-08): the `BoardgameResult` winner/method tie (§5.2, in W2b); held-
fixture auto-walkover (W2b-R8, already here); `division_has_results` (V355) and the me-officiating view dropping
`needs_decision` fixtures — **taken by W2a** (f-w2 controller ruling D-F3: readers of W2a's own status, fixed in loop
F; W2b does not scope them); legacy completed stages whose fixture V432 moves to `needs_decision` — answer pending from W2a.

## 13. False premises found (W2b) — for `_INDEX.md` at fold

1. The W2b brief listed C17 as an owner constraint; it was a W2a controller ruling (preflight flagged it for the
   owner). W2b-R8 is the owner's first answer.
2. RB2B-14 (signed 72) said settle gives a double no-show "an honest record instead of a fake walkover"; settle
   actually advances one absent side. W2b-R2 replaces that path.
3. RBB contradicts itself on double-walkover goals (football "0-3 each", hockey "0-5 each", RB2B-15 "no goals");
   W2b-R3 rules no score.
4. No source assigned ST-G1 (high, live) to W2b; W2b-R1 does.
5. RBB §8's new gap ids were never registered in `_INDEX`.
6. "Replay" for an abandoned match is not a feature: `replayFlagged` is read nowhere in apps/web; the console only
   offers voiding the abandon, which resumes the old stream.
7. W2a's planned X-ST-2 list missed chess `boardgame.result{forfeit | double_forfeit}`; f-w2's owner fixed it (D-O1).
8. Seating and ranks disagree on an `award` loser in double elimination (`fed-seats.ts:97-103` vs
   `competition.ts:153-165`).
9. Auto-advance treats `finalized` as open (`scoring.ts:826-830`) — to reproduce.

## Appendix A — Rule rows to add to `packages/engine/rules/` (at build)

Format: `packages/engine/rules/README.md` on `feat/format-matrix-w2a`. Status `signed W2b-Rn` is rewritten to
`signed <_INDEX ruling number> 2026-10-08` when the rulings are folded (§10). `enforced at` and `proved by` are filled
at build; a signed or deviation row ships only with a proving test whose title contains the id.

54 rows: cross-sport.md 23, football.md 3, hockey.md 3, icehockey.md 3, volleyball.md 2, tabletennis.md 2, tennis.md 2, badminton.md 3, cricket.md 3, boardgame.md 4, carrom.md 3, generic.md 3.

### `cross-sport.md`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| X-RS-1 | A forfeit records one reason from a closed list (walkover, retired, disqualified, withdrew), never free text; walkover = before play started (chess also after the session starts, FIDE 6.7.1), retired/disqualified = after. | product rule W2b-R1 | signed W2b-R1 2026-10-08 | — | — |
| X-RS-2 | Public results name the reason: "w/o" for walkover/withdrew, "ret." for retired, "DQ" for disqualified, in all 4 locales. | product rule W2b-R1 | signed W2b-R1 2026-10-08 | — | — |
| X-RS-3 | Every event that records a forfeit, walkover, retirement or double walkover is organiser-only, through the X-ST-2 predicate. | product rule W2a D-O1 (f-w2 owner) + W2b-R1 | signed W2b-R1 2026-10-08 | — | — |
| X-DW-1 | A double walkover is its own outcome: both sides lose, nobody advances. | FDC 2025 Art. 28 (each side forfeits); FIDE Laws Art. 11.8 ("lost by both") | signed W2b-R2 2026-10-08 | — | — |
| X-DW-2 | In a bracket, every seat a double walkover feeds is dead, and that seat's opponent advances by walkover; in double elimination neither side drops to the losers' bracket; a third-place feed is won by walkover by the other semi-final loser. | FDC 28; product rule W2b-R2 | signed W2b-R2 2026-10-08 | — | — |
| X-DW-3 | A double walkover is refused where the fixture has no next match (final, last rung, third-place match) with guidance: reschedule, record a walkover if one side turned up, or settle as a last resort; the fixture stays open. A vacant title is W4 (with joint winners). | product rule W2b-R2 | signed W2b-R2 2026-10-08 | — | — |
| X-DW-4 | In a table a double walkover is P+1, L+1, 0 points for both, no score credited, and excluded from every ratio (set/game %, NRR, goal ratios). | product rule W2b-R3 (no federation score) | signed W2b-R3 2026-10-08 | — | — |
| X-BR-1 (amend) | "decided only by a win" → "decided only by a win or a double walkover". | W2b-R2 amends ruling 79 | amend at build | — | — |
| X-WO-1 | Walkover and retirement credit is derived from the stage's own cfg (best-of, target score, overs), and the same credited score is used in the table, tie-breaks, the public page and the qualification view. | product rule W2b-R4 | signed W2b-R4 2026-10-08 | — | — |
| X-RT-1 | In-match disqualification takes the sport's retirement credit for that match (the cascade to other fixtures is W5). | product rule W2b-R5 | signed W2b-R5 2026-10-08 | — | — |
| X-AB-1 | An abandoned match counts in a table only when the sport's rule gives it a result; otherwise it stays out and is flagged for replay or settle. | ICC 16.10.3; RBB §7 item 3; W2b-R6 | signed W2b-R6 2026-10-08 | — | — |
| X-AB-2 | An abandoned match with a result is decided (status follows the result), shows "Abandoned — <reason>", and auto-advance treats it as finished. | product rule W2b-R6 (RB2B-33) | signed W2b-R6 2026-10-08 | — | — |
| X-AB-3 | Abandons recorded before W2b keep their stored status (no backfill). | product rule W2b-R6 | signed W2b-R6 2026-10-08 | — | — |
| X-AB-4 | A forfeit while an abandon is active is refused ABANDONED_SETTLE_OR_VOID with guidance (settle to decide; void the abandon first if replaying); void-then-forfeit stays allowed and is credited as a retirement (the stream keeps the pre-abandon score). | RB2A-31; product rule W2b-R7 | signed W2b-R7 2026-10-08 | — | — |
| X-WD-1 | When a side withdraws from a held (needs_decision) bracket fixture, the fixture is walked over to the remaining side, reason "withdrew", with retirement credit (played score stands). | product rule W2b-R8 (answers C17) | signed W2b-R8 2026-10-08 | — | — |
| X-WD-2 | A withdrawal from page_playoff or ladder walks the remaining fixtures over, as knockout does; it never voids them. | product rule W2b-R8 | signed W2b-R8 2026-10-08 | — | — |
| X-WD-3 | A withdrawal from a bracket fixture whose opponent is not yet known marks the withdrawn seat dead, so the arriving opponent advances by walkover (reproduce before fix). | product rule W2b-R8 | signed W2b-R8 2026-10-08 | — | — |
| X-WD-4 | When both sides of a fixture have withdrawn, the fixture is a double walkover (X-DW-*); a final goes to settle (X-DW-3). | FDC 28; product rule W2b-R8 | signed W2b-R8 2026-10-08 | — | — |
| X-PS-1 | A walkover, withdrawal or double walkover never counts as a match played in any player's stats, and credits no personal W/L. | product rule W2b-R9 (ATP/ITF/FIDE rating practice) | signed W2b-R9 2026-10-08 | — | — |
| X-PS-2 | A retirement, in-match DQ or abandon with a result counts as a match for both sides' players, W/L as decided; events already played stay credited. | product rule W2b-R9 | signed W2b-R9 2026-10-08 | — | — |
| X-DE-1 | In double elimination any forfeit loser (walkover, withdrew, disqualified, retired) is out of the tournament: it never drops to the losers' bracket, its losers'-bracket opponent advances by walkover, and final ranks place it as eliminated in that round (seating and ranks agree). | product rule W2b-R11 | signed W2b-R11 2026-10-08 | — | — |
| X-WD-5 | A withdrawn entrant is never seated on a loser edge; the seat is dead and its opponent advances by walkover. | product rule W2b-R8 (W2a D-G2) | signed W2b-R8 2026-10-08 | — | — |
| X-BL-1 | A division's results for the quota slot exclude no-result and double-walkover fixtures; a single walkover counts. | product rule W2b-R13 | signed W2b-R13 2026-10-09 | — | — |

### `football.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| FB-WO-1 | Football walkover = 3-0. | FDC 2025 Art. 28.1 | signed W2b-R4 2026-10-08 | — | — |
| FB-RT-1 | Football retirement or post-start forfeit = 3-0, or the real score if it is worse for the offender. | FDC 2025 Art. 28.1 | signed W2b-R5 2026-10-08 | — | — |
| FB-AB-1 | Football abandon under abandonPolicy award: leader wins with the real score; level = draw with the real score in draw kinds, needs_decision in brackets. | product rule W2b-R6 | signed W2b-R6 2026-10-08 | — | — |

### `hockey.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| HK-WO-1 | Hockey walkover = 5-0 (default changes from 3). | FIH GTR Reg 13.1 | signed W2b-R4 2026-10-08 | — | — |
| HK-RT-1 | Hockey retirement or post-start forfeit = 5-0, or the real score if worse for the offender. | FDC 28.1 analogue (RBB RB2B-6) | signed W2b-R5 2026-10-08 | — | — |
| HK-AB-1 | Same as FB-AB-1 for hockey. | product rule W2b-R6 | signed W2b-R6 2026-10-08 | — | — |

### `icehockey.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| IH-WO-1 | Ice hockey walkover = 5-0. | product rule (IIHF Rule 66 names no score) W2b-R4 | signed W2b-R4 2026-10-08 | — | — |
| IH-RT-1 | Ice hockey retirement or post-start forfeit = 5-0, or the real score if worse for the offender. | FDC 28.1 analogue | signed W2b-R5 2026-10-08 | — | — |
| IH-AB-1 | Same as FB-AB-1 for ice hockey. | product rule W2b-R6 | signed W2b-R6 2026-10-08 | — | — |

### `volleyball.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| VB-WO-1 | Volleyball walkover = the sets needed to win, each 25-0. | FIVB 6.4.1 | signed W2b-R4 2026-10-08 | — | — |
| VB-RT-1 | Volleyball retirement (incomplete team) = winner given the sets and points it needed; the retiring side keeps what it won. | FIVB 6.4.3 | signed W2b-R5 2026-10-08 | — | — |

### `tabletennis.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| TT-WO-1 | Table tennis walkover = the games needed to win, each 11-0. | ITTF Handbook 2.3.7 | signed W2b-R4 2026-10-08 | — | — |
| TT-RT-1 | Table tennis retirement = points played stand, current game completed for the winner, remaining games 11-0. | ITTF Handbook 2.3.7 | signed W2b-R5 2026-10-08 | — | — |

### `tennis.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| TN-WO-1 | Tennis walkover = straight sets for set %; the match's games excluded from game %. | ATP 4.01 C.4 | signed W2b-R4 2026-10-08 | — | — |
| TN-RT-1 | Tennis retirement = same credit as TN-WO-1. | ATP 4.01 C.4 | signed W2b-R5 2026-10-08 | — | — |

### `badminton.md (new)`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| BD-WO-1 | Badminton walkover = 2-0 games, each 21-0. | product rule (BWF silent) W2b-R4 | signed W2b-R4 2026-10-08 | — | — |
| BD-WO-2 | In a badminton group stage BD-WO-1 applies instead of BWF GCR 16.2.5's delete-all-results (until W5). | BWF GCR 16.2.5 | deviation W2b-R4 2026-10-08 | — | — |
| BD-RT-1 | Badminton retirement = points played stand, current game completed to 21, remaining games 21-0 (until W5's 16.2.5). | BWF GCR 16.2.5 | deviation W2b-R5 2026-10-08 | — | — |

### `cricket.md`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| CK-WO-1 | Cricket forfeit (incl. refusal to continue) = full points to the winner; the defaulter is charged its full quota at 0 runs in NRR; the winner's NRR is unaffected. | ICC T20WC PC 16.10.7, 16.2 | signed W2b-R4/R5 2026-10-08 | — | — |
| CK-AB-1 | Cricket abandon after the minimum overs with a DLS result counts as that win/tie. | ICC T20WC PC 16.10 (DLS) | signed W2b-R6 2026-10-08 | — | — |
| CK-AB-2 | Cricket abandon with no result = 1 point each and an NR column entry. | ICC T20WC PC 16.10.3 | signed W2b-R6 2026-10-08 | — | — |

### `boardgame.md`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| BG-WO-1 | Chess walkover or post-start forfeit = 1-0, counts as a game for table tie-breaks, excluded from colour history. | FIDE C.07 (read, summary) | signed W2b-R4/R5 2026-10-08 | — | — |
| BG-DW-1 | Chess double_forfeit folds to the double walkover outcome in every stage kind (retires T15-R1's hold). | FIDE Laws Art. 11.8 | signed W2b-R2 2026-10-08 | — | — |
| BG-WO-2 | A chess forfeit is recordable before the game starts (no-show), credited as a walkover. | FIDE Laws Art. 6.7.1 | signed W2b-R8 2026-10-08 | — | — |
| BG-WO-3 | A chess fixture whose tie-break is pending is walked over to the remaining side when one player withdraws or does not turn up for the tie-break games; the classical game stays a draw in player stats. | product rule W2b-R14 | signed W2b-R14 2026-10-09 | — | — |

### `carrom.md`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| CA-WO-1 | Carrom walkover = games needed to win, each 25-0. | product rule (ICF silent) W2b-R4 | signed W2b-R4 2026-10-08 | — | — |
| CA-RT-1 | Carrom retirement = completed games stand, the unfinished game 25–(opponent's score), remaining games 25-0. | product rule W2b-R5 | signed W2b-R5 2026-10-08 | — | — |
| CA-AB-1 | Carrom abandon = replay by default (no shared points; opt-in sharing is W2c). | product rule RB2B-25 / W2b-R6 | signed W2b-R6 2026-10-08 | — | — |

### `generic.md`

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| GN-WO-1 | Generic walkover = win points, 0-0 (stage-level awarded score is W2c). | product rule W2b-R4 | signed W2b-R4 2026-10-08 | — | — |
| GN-RT-1 | Generic retirement = walkover credit, keeping any recorded score. | product rule W2b-R5 | signed W2b-R5 2026-10-08 | — | — |
| GN-AB-1 | Generic abandon = replay by default (no shared points; opt-in sharing is W2c). | product rule RB2B-25 / W2b-R6 | signed W2b-R6 2026-10-08 | — | — |
