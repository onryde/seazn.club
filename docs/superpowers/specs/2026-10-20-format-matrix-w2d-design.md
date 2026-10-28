# Format matrix W2d — tables and tie-breaks (design)

- **Date:** 2026-10-20 · **Programme:** format × sport matrix, wave W2, sub-wave **W2d** ("tables and tie-breaks",
  ruling 71)
- **Status:** owner decisions Q1–Q11 taken in session f-w2d on 2026-10-20 and recorded below as D1–D11. This written
  spec is **not yet approved**. No product code until the owner approves the spec, then the plan and its execution
  method. A builder check of the first draft raised further questions, and the owner answered them the same day
  ("All ok"); they are recorded as B1–B5 (§3). Items marked **orchestrator's call** are the f-w2d orchestrator's, not
  the owner's (`_RULES.md` R4, AGENTS.md class 17), and are to be put to the owner. Items marked **author's call** are
  this spec's own choices where the decisions are silent. §17 lists them. **Approved by the owner 2026-10-20 at
  `8168a0b92a`** (plan header). At the fold (W2d Task 21, 2026-10-28) D1–D11 became programme rulings 177–187, B1–B5
  rulings 188–192, OC1–OC3 rulings 193–195 and the approval ruling 196, in `_INDEX.md`'s "Owner rulings".
- **Worktree / branch:** spec on `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d`, branch
  `docs/format-matrix-w2d`, from `origin/main` `dec7b95d90`. The build branch is a fresh `feat/format-matrix-w2d` off
  main **after W2c (`feat/format-matrix-w2c`) merges** (D1).
- **Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`,
  `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` and `_INDEX.md` (rulings 129–134 and W2c's fold
  exist only on the W2c branch until it merges), the W2b design (`2026-10-08-format-matrix-w2b-design.md`) and the W2c
  design (`2026-10-13-format-matrix-w2c-design.md`, W2c branch).
- **Code read at:** main `dec7b95d90` (shown as "main"). Where marked "W2c", the W2c worktree at `2bcc66313b`. The
  input ledger cites `0a00268abb`; every W2c line quoted here was re-read at `2bcc66313b` and still holds. Citations are
  pins for the plan, not promises. The plan re-pins them after rebasing onto W2c.
- **Input ledgers (gitignored):** `.superpowers/handoff/2026-10-20-w2d/`: `decisions.md` (Q1–Q11 and the
  builder-check round, verbatim),
  `docs-facts.md`, `code-facts.md`, `stage-gates-facts.md`.

Path legend for citations. **RBG** = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-goals-boards.md`.
**RBS** = `…/rulebook-W2-sets-cricket.md`. **AUD-ST / AUD-SC** = `…/audit-2026-09-27/ST-standings.md` / `SC-scoring.md`.
**IDX** = `…/_INDEX.md` (main). **W2C** = the W2c design. Engine paths are relative to `packages/engine/src/`. Web paths
are relative to `apps/web/src/`.

## 1. Why, and what done means

A standings table is the organiser's most public promise, and today it can break that promise in five ways:

- **One cascade per division, edited blind.** The tie-break order is `divisions.tiebreakers` or the sport default
  (`server/engine-db/competition.ts:454-456`). There is no per-stage order and no editor. `validateCascade`
  (`competition/tiebreakers.ts:638-695`) has no production caller, so a key the sport never records (`nrr` in football,
  `buchholz` outside Swiss) is saved without complaint and then compares every pair level. The driver also skips any key
  it has no comparator for without a word (`tiebreakers.ts:529-537`).
- **A table cannot see how a match was won.** OT and shoot-out live in a free-string `outcome.method`
  (`core/types.ts:170-176`). A `StandingsDelta` carries only won/drawn/lost/points/metrics (`core/types.ts:238-247`).
  So a stage `PointsRule` (`competition/points.ts:12-38`) cannot pay IIHF 3-2-1-0, FIH Pro League 3-2-1-0, a cricket tie,
  or the FIVB 3-2 split. On main it flattens them silently (AUD-SC:118 SC-P10). W2c refuses them instead
  (`POINTS_RULE_INEXPRESSIBLE`, W2c `points.ts:254-277`).
- **Federation orders are missing or wrong.** Badminton, table tennis and volleyball rank with no difference keys and
  with h2h last. Volleyball ranks points before wins (RBS:318 VB-9). Tennis has no matches-played key (RBS:400). Hockey
  has no `wins` and no field goals (RBG:271). UEFA re-application is unreachable (F9). Ice hockey never re-applies H2H
  (RBG:381).
- **Residual ties are decided by a database id**, which the page calls "seeding" (AUD-ST:72 G13). Where `lots` exists,
  it hashes a stage seed that is usually absent (`competition.ts:466`, `tiebreakers.ts:576`). The completion event
  records the tied group but not the order drawn (`competition/stage.ts:104-105`).
- **The best-third comparison ignores the sport.** `progression.ts:573-575` ranks across groups by
  `points, diff, for, wins` for every sport (AUD-ST:63 G4).

**Owner value:** each stage ranks by its sport's real rules, and the organiser can see and change them before play. Once
play starts the table cannot move under anyone. A step that cannot work is refused when it is saved, never at the end of
the group, and a dead heat is settled by a drawing of lots that stays the same on every reload.

**Done means:**

1. Every item in §2.1 is built with its four test types (unit, e2e, smoke, regression) and the seven-part test design
   in §13, or carries an owner verdict "not built, because…".
2. Every rule row in Appendix A is signed at plan start, enforced, and proved by a test whose title carries its id.
3. `validateCascade` runs on every write path listed in §5.5. A source-scan test proves no other path writes a cascade.
4. One resolver supplies the effective table rules (points and order) to every consumer in §6. A source scan proves no
   file outside it reads `defaultTiebreakers` or `division.tiebreakers`.
5. The stage editor (D11) passes a 1280 sign-off. Its e2e spec is green at all seven widths, run by CI dispatch.
6. MD-1: every Survived or NoCoverage mutant in the engine lines W2d owns is classified (§14).

## 2. Scope

### 2.1 In W2d

| # | Item | Source | Decision |
|---|---|---|---|
| 1 | Per-stage tie-break order, inherited stage → division → sport default (for the stage kind), with an editor | ST-G10, RB2A-25, RBG:131/:476, F-21, H-18, B-13 | D3, D11 |
| 2 | `validateCascade` rewritten and wired at every write path | ST-G10, RB2A-15, RB2B-36, RBG:713 | D3, D10(d) |
| 3 | `decidedIn` (regulation / OT / SO): a per-sport reachable set, derived from the recorded events | ST-G16, RB2B-7/8, SC-P5 | D4 |
| 4 | `PointsRule` widened to outcome-keyed payouts (cricket tie/NR/two-innings draw, unplayed loss, set-score map, half-point unit); `POINTS_RULE_INEXPRESSIBLE` retired | SC-P10, ST-G9, RB2A-24, RB2B-37 | D4, D6, D10 |
| 5 | Pin when the stage becomes active; the stage's own settings lock on first score; division and sport changes reach only unpinned stages; a fixture override must stay covered by the points rule | W2C:371-372, O8 | D3, D9, OC2 |
| 5a | Migration pins every active or complete stage to the rules it uses today and converts old-shape stage points | — | B1 |
| 5b | A shoot-out in football and FIH is a draw plus a bonus; FIH "matches won" counts regulation wins only | RB2B-7, SC-P5, F-9, H-7 | B2 |
| 6 | New tie-break keys and h2h modes (table in §5.6) | RB2A-2, RB2A-11, RB2B-4/11/12/19, TT-8 | D5 |
| 7 | Stored, seeded lots draw at the end of every non-Swiss cascade (and wherever a Swiss order already lists `lots`) | ST-G13, RB2A-9, TT-9, BD-9, ruling 70 | D5, D7, OC1 |
| 8 | Cross-group (best-Nth) ranking by the source stage's own order | ST-G4 | D3, D7 |
| 9 | IIHF partial-schedule order | ST-G12, RB2B-12, I-10 | D7 |
| 10 | Per-sport defaults for points and order, exactly as signed, with a `deviation` row for each deliberate gap | RB2A-2/7/9/10/11/24, RB2B-4/5/7/8/11/12/17/18/19/27 | D5, D10 |
| 11 | TT 2/1/0, with an unplayed loss paying 0 (ruling 108 amended) | RB2A-7, TT-5 | D6 |
| 12 | Fair play only in football, and only while football's `fairPlay` is on | — | D8 |
| 13 | Chess points shown in half-points ("1½") | ST-G2, RB2B-17 | D10(b) |
| 14 | Volleyball best of 3 points; the `pointsMap` guard fires even when `"*"` is present | SC-S9, RB2A-10 | D10(a) |
| 15 | Margin bonuses read the sport's own score keys (`gf/ga/gd`, `runs_*`) | SC-P10 (AUD-SC:118), F11 | author's call: part of widening `PointsRule` (D4) |
| 16 | The table columns the new keys need: set/point difference, field goals, Sonneborn-Berger in round robin, tennis game ratio (ST-G29), IIHF OTW/OTL | ST-G16, ST-G29 | follows from D4/D5 |

### 2.2 Non-goals, each with its owner

| Item | Owner |
|---|---|
| Unlimited stages; carry-over, auto-progress, byes, cross-feeds and placements free on every plan | separate PR `feat/all-stages-free` (D2, provisional V469). W2d depends on it only for migration order |
| Swiss cascade content (Buchholz family, ARO, progressive), Swiss pairing, SW-M1 bye-order Buchholz bug (F12), P6 empty round | W3. W2d's validator and stored lots are the base W3's SW-H4 builds on (`W3-swiss.md:26`, ruling 70) |
| Sport fidelity: continuous sudden-death OT (SC-P3), sanction and short-team endings, BWF 3×15, older mutation survivors in sport modules | W2e |
| Unequal-pool normalisation (ST-G3), the other ST-G items routed to W5 | W5 (only ST-G4, ST-G12 and ST-G13 move here, D7) |
| Division builder and settings redesign; a division-level cascade editor | after W2 (owner 2026-10-19). Author's call: in W2d the division default stays settable through the API and templates only |
| Per-fixture points or tie-breaks | **never** (ruling 12) |
| UEFA Art. 20.02 (a level last-match pair decided by penalties) | not offered (D5; RB2B-5) |
| New fair-play scales for other sports | not built (D8) |
| Goals-away, play-off/test-match deciders, IIHF steps 4–5, FIH ranking shoot-out, FIFA world ranking | not built: deviation rows (§5.10) |

### 2.3 Anti-goals (each is a test, §13)

1. **A table that moves under a started stage.** No edit to a division default, a sport default, the engine, or W2d's
   own release may change the points or order of an active or complete stage. The stage pin (§5.4) is the only source
   such a stage reads, and the migration pins every existing one before the new defaults ship (B1).
2. **A tie-break step that silently does nothing.** A key the sport cannot record, or the stage format has no data for,
   is refused at write. A key with no comparator throws at rank time instead of being skipped (today
   `tiebreakers.ts:529-537` skips it). A conditional step (h2h for exactly two, a partial-schedule guard) states in the
   tie popover why it did not split.
3. **A "leader" on an empty table.** With zero counted fixtures every entrant is level. No lots are drawn or stored, and
   no row is shown or marked as first (RBG:31-33).

## 3. W2d decisions and the rulings they amend

The owner gave these decisions on 2026-10-20 in session f-w2d. They are numbered D1–D11 here and get ruling numbers at
the fold. Those numbers come after W2c's, which W2c assigns at its own fold (W2C:119-120, docs-facts §7.7). The wording
below condenses `decisions.md` without changing it.

| D | Q | Owner's choice (2026-10-20) |
|---|---|---|
| D1 | Q1 | All scoring is free. The UI is correctness-first in the existing pattern, signed off at 1280, with e2e at all 7 widths. W2c merges first. Migrations take main's max+1 at rebase, and whoever lands second renumbers (agreed with r2 and f-w2c) |
| D2 | Q1+/Q2 | "All stages are free" is option 2 and ships as a SEPARATE PR `feat/all-stages-free` (V469 provisional). Not W2d |
| D3 | Q3 | The tie-break order is PER STAGE, inheriting division → sport default. A plain editor in the existing settings pattern: ordered list, reorder/remove, reset to default, Inherited/Overridden badge. `validateCascade` on save refuses criteria the sport or stage cannot evaluate (GD in chess, H2H on a cross-group table). A stage's order locks once any fixture in it has a score, mirroring W2c Q3. The stage-level order replaces the hard-coded cross-group order (`progression.ts:574`) |
| D4 | Q4 | A structured "decided in" (regulation/OT/SO) on every result. Each sport declares its reachable set. The value is DERIVED from the pad's score events, never hand-picked. `PointsRule` widens to outcome-keyed payouts (W/D/L × decidedIn, plus cricket tie/NR), and a sport shows only its reachable outcomes. Retires `POINTS_RULE_INEXPRESSIBLE` (SC-P10). The owner also asked for a backfill of finished matches from existing events, so tables do not move |
| — | Q4 note | `decidedIn` is DERIVED at standings time from the outcome the event fold produced: one authority, no stored column, so finished matches need no per-match backfill. The owner's "tables don't move" is met by B1 (the migration pins every active or complete stage to today's rules), which replaces the earlier "no backfill" note |
| D5 | Q5 | SIGNED: the per-sport points and default-cascade table (§5.10). Every cascade ends in a STORED lots draw (Swiss exempt, OC1). The new defaults apply to ALL divisions with no per-division snapshot (overrides RB2A-2's "new divisions only"), but reach only stages not yet active: B1 pins every active or complete stage. Each deviation gets a `rules/` `deviation` row |
| D6 | Q6 | Ruling 108 is amended: a sport may declare that an UNPLAYED loss (walkover, retired, defaulted) pays its "loss, not played" value. Table tennis declares 0 (a played loss pays 1). Every other sport keeps 108 unchanged. This also touches X-WO-1 |
| D7 | Q7 | ST-G4 (cross-group best-Nth comparison), ST-G12 (IIHF partial-schedule order) and ST-G13 (residual seed → UUID, replaced by stored lots) MOVE from W5 to W2d. The W5 brief is amended (§12.3). Swiss cascades and pairing stay W3. W2d's stored lots draw is the base W3 builds on (ruling 70) |
| D8 | Q8 | Fair play is already built (football FIFA scale, `football.ts:1060-1081`, metric `fair_play`). W2d offers `fair_play` ONLY in football. `validateCascade` refuses it for any other sport, and for football when the `fairPlay` cfg is false. No new scales |
| D9 | Q9 | PIN at stage start: the stage freezes its effective points rule and tie-break order (inherited or its own). Later division-default edits reach only unstarted stages. Badge "Pinned at start". The stage's own settings lock on first score (D3); other W2c settings keep W2c's lock. Fixture override (W2c, match format only, ruling 12): the stage's points rule must cover every outcome reachable under the stage format OR any fixture override. By default an OT win pays a win and an OT loss pays a loss, unless a split is set (the shoot-out half of this sentence is superseded by B2). An override save is refused, naming the uncovered outcome, when the organiser's rule excludes it |
| D10 | Q10 | SIGNED all six: (a) volleyball best of 3: 2-1 ⇒ 2:1, 2-0 ⇒ 3:0; the `pointsMap` guard fires even with `"*"` (SC-S9/RB2A-10). (b) Chess Pts are displayed as half-points, "1½" (ST-G2/RB2B-17). (c) Cricket two-innings draw points exist only when the format has two innings; default 1. (d) `validateCascade` refuses keys the SPORT cannot emit (`nrr` outside cricket, `board_ratio` outside carrom) or the STAGE FORMAT has no data for (`buchholz` outside Swiss). Swiss-format keys are valid in any sport's Swiss stage (RB2A-15/RB2B-36). (e) W2c's `shootoutWin`/`shootoutLoss` are superseded by the outcome-keyed rule; coordinate the handover with f-w2c. (f) SC-P4 oracle: FIH default 3/1/0 with draws; the shoot-out case tests the Pro League preset 3/2/1/0 (re-expressed by B2 as draw 1 + shoot-out bonus 1, same points) |
| D11 | Q11 | OPTION A: an inline ordered list in the stage settings section (existing W2c pattern). Up/down/remove per step, "+ Add step", "Reset to sport default". Badge Inherited / Overridden / Pinned at start. A `validateCascade` error shows inline next to its step. Once the stage has a score, the arrows are hidden and a lock line shows. **Orchestrator's call (to tell the owner):** the FIRST step is pinned to the sport's primary measure (points, or wins for volleyball, badminton and tennis), not literally "Points". Lots are pinned last |

**Builder-check round (owner "All ok", 2026-10-20).** These are owner decisions and fold as rulings like D1–D11.

| B | Owner's choice (2026-10-20) |
|---|---|
| B1 | **Production data.** The W2d migration pins every active or complete stage to the rules it uses TODAY (its current effective points and cascade), and converts old-shape `stages.config.points` to the new `PointsRule` shape. New defaults reach only unstarted stages, and no production table moves. Owner fact: production has exactly ONE competition, a Swiss badminton one |
| B2 | **Shoot-outs in football and FIH are a draw plus a bonus** (rulebook RB2B-7, signed with Q5). The W/D/L columns show D, and the shoot-out winner gets a bonus (default 1, so 2/1 with a draw worth 1). FIH "matches won" counts regulation wins only. Ice hockey keeps OTW/OTL (IIHF has no draws). A knockout shoot-out decides who advances, nothing else. Supersedes D9's "an SO win pays like a win" |
| B3 | **Hockey field goal** = any goal not scored from a penalty corner or a penalty stroke. Own goals count. If the pad does not record the goal type, W2d makes it do so |
| B4 | **Volleyball double round robin head-to-head** aggregates both legs |
| B5 | **Chess Sonneborn-Berger under a 3/1/0 stage** uses game points (1/½/0) |

**Orchestrator's calls from the same round** (the orchestrator's, not the owner's; to be put to the owner):

| OC | Call |
|---|---|
| OC1 | **Orchestrator's call:** Swiss stages keep their current per-sport orders (W3 owns them) and are exempt from the first/last pinned shape rule. `validateCascade`'s key and stage-format checks still apply to them |
| OC2 | **Orchestrator's call:** the pin is written when the stage's status becomes `active`. The stage's own settings still lock at its first score (D3) |
| OC3 | **Orchestrator's call:** `h2h_two` may repeat in an order (the BWF and ATP orders need it after each step). No other key may repeat |

**Ruling 108 amendment text (D6), for the fold:** "A credited result pays the table points of its credited score. The
exception: a sport may declare a *loss-not-played* value, and then the side that loses an award (walkover, retirement,
default, disqualification or withdrawal; never a bye, which has no loser) is paid that value instead. The winner is
still paid its credited score's points. Table tennis declares 0 (ITTF 3.7.5.1). No other sport declares one." X-WO-1's
row text gains the same exception. W2b's "one rule for every credited result, with no offender-gets-0 exception" stays
true for every sport except table tennis.

**Rulings implemented, not changed:** 12 (never per-fixture points or tie-breaks); 42 (every possibility owned: §2.2);
70 (lots); 71; 75 (rules reference rows); 79 (hold, don't refuse; brackets only); 85 X-DW-4 (a double walkover pays 0
and is out of every ratio); 86 X-WO-1; 88 (an abandon counts only with a result; cricket NR pays 1); 105 (expunged
fixtures); 125 CK-WO-2; W2c X-PT-1 and X-SR-3/X-SR-4 (narrowed by D9, §5.4); MD-1.

## 4. False premises and corrections found (for `_INDEX` at fold)

"Brief" means the W2d kickoff brief (`resume-2026-10-14.md:97` plus the claims checked in code-facts). Sources are
code-facts F1–F12, docs-facts §7, and this spec's own reads (marked "spec").

| # | Premise | Truth | Evidence |
|---|---|---|---|
| P1 | W2c added `fairPlay` | It is football's cfg flag on main since `bd0ccac9b0` (2026-07-03) | `sports/football/football.ts:130`; W2c diff has no match (F1) |
| P2 | A per-sport outcome vocabulary (OTW/OTL/SOW/SOL) exists | Outcome kinds are global. OT and SO are a free-string `method` on a `win`, which only the module reads | `core/types.ts:162,170-176`; `sports/period/kernel.ts:1503-1514`; `football.ts:2721-2730` (F2) |
| P3 | Table tennis pays 2/1/0 | It pays 2/0, and so does badminton | `sports/setbased/tabletennis.ts:30`; `badminton.ts:28` (F3) |
| P4 | `validateCascade` guards cascades | It is defined and never called. The API accepts any enum key for any sport | `tiebreakers.ts:638-695`; `server/api-v1/schemas.ts:318-322,443,472,552` (F4) |
| P5 | W2c built a "tie-break order" UI | That control is the chess MATCH tie-break rungs. No tree has a standings-cascade editor | W2c `components/v2/stage-rules/sequence-field.tsx` (F5) |
| P6 | W2c's V463 lands cleanly | It sits below main's V464–V467, and Flyway refuses out-of-order migrations | W2c `V463__fixture_rules_override.sql:1-7`; `db/flyway.toml` has no `outOfOrder` (F6; the refusal is INFERRED from that header, not run) |
| P7 | `POINTS_RULE_INEXPRESSIBLE` is on main | It exists only on W2c. Main flattens silently | (F7); AUD-SC:118 |
| P8 | W2c's refusal is exact | It over-refuses: cricket NR is expressible, and because schema defaults apply, every cricket division is refused | W2c `points.ts:266-277`; `cricket.ts:59-66` (F8) |
| P9 | UEFA recursive h2h is offered | `h2hRecursive` is never set by web, so every table runs FIFA fall-through | `tiebreakers.ts:209,456`; `competition/stage.ts:72,243` (F9) |
| P10 | Cross-group ordering follows the division | It is hard-coded `points, diff, for, wins` | `competition/progression.ts:570-575` (F10) |
| P11 | Margin bonuses work for goal sports | They are refused for every sport except generic: the rule reads `for/against/diff` and goal sports emit `gf/ga/gd` | `points.ts:45-55,61-66` (F11) |
| P12 | Chess Buchholz is correct | Byes are appended after results, so a round-1 bye is scored as the last round (SW-M1, open; W3) | `tiebreakers.ts:726-742,63-68` (F12) |
| P13 | `points.ts` is W2d's MD-1 file (IDX:3507) | W2c moved it to W2c (W2C:344). W2d re-checks only the lines it moves | docs-facts §7.1 |
| P14 | ST-G10 belongs to W5 (AUD-REV:19) | Stale. The owner routed it to W2d (routing a) | W2C:94; docs-facts §7.2 |
| P15 | "Hockey SO 2/1" is the FIH default | FIH 2/1 is the Pro League rule only. The default is 3/1/0 with draws | RBG:725-732; IDX:1922-1926 (docs-facts §7.4) → D10(f) |
| P16 | TT 2/1/0 fits ruling 108 | It does not: an unplayed loss must pay 0 | RBS:220-221,245,562 → D6 |
| P17 | Stryker is "not installed" (TEST-STRATEGY.md:123-127) | Stale against MD-1: there are per-family floors and CI runs group=all | IDX:3474-3517 (docs-facts §7.6) |
| P18 | Snapshot new defaults into new divisions only (RB2A-2) | Superseded: no per-division snapshot; the defaults apply to every division but reach only stages not yet active, because the migration pins every active or complete stage | D5; B1 |
| P18a | Greenfield means no production data to protect | Production holds one competition (a Swiss badminton one), which the migration pins | B1 (owner fact) |
| P19 | The W2c Q3 lock is "per started inheriting stage" for tie-breaks | The built lock fires on any started table stage, because no stage can override yet | W2c `usecases/rule-locks.ts:113-117` (docs-facts §7.13) → replaced by the pin (§5.4) |
| P20 | A cascade without a usable key is merely weak | The driver skips a key it has no comparator for, silently | `tiebreakers.ts:529-537` (spec) |
| P21 | Lots are recorded | The `rank_lock` event carries the sorted group, not the drawn order. The draw is re-hashed on every recompute from `stages.config.rngSeed`, which is optional and usually absent (seed 0) | `competition/stage.ts:104-105,253-256`; `competition.ts:466`; `tiebreakers.ts:547-556,576` (spec) |
| P22 | The chess default can run in a round robin | `validateCascade` refuses `direct`/`sberger` outside Swiss, and `sberger` compares level without a Swiss ledger. The chess round-robin default is effectively points → direct → wins → lots | `tiebreakers.ts:351-360,687-692`; RBG:498 B-12 (spec) |
| P23 | Hockey records field goals | The kernel emits `goals_<kind>` for every kind except `fg` and `og`, so there is no field-goal ledger. It is derivable as `gf − goals_pc − goals_stroke` (B3), but the pad's goal type is optional, so an untyped corner goal would count as a field goal | `period/kernel.ts:240,1098-1101,1986,2413-2416` (spec) |
| P24 | Football `fair_play` with `fairPlay:false` is refused or ignored | It is emitted as 0 for every side, so the key is inert | `football.ts:1724` (spec) |
| P25 | The tie what-if works for every sport | It returns null unless `points` is the first key, so a wins-first order loses it | `competition/tie-what-if.ts:54-60` (spec) |
| P26 | One place resolves a division's cascade | Six files each resolve `tiebreakers ?? defaultTiebreakers` themselves | §6 rows W1–W6 (spec) |
| P27 | A football shoot-out is scored with `football.penalty` kicks (§5.2, §13.5, brief Task 14) | `football.penalty` is an in-play penalty kick awarded to a side. A shoot-out kick is `football.shootout.kick`, applied in the SHOOTOUT phase | `football.ts:340-341,464-465,2233-2236` (T14) |
| P28 | The stage activation writers are `usecases/stages.ts:2813` and `:3644` (§5.4, §6 W13, §13.5) | The lines moved. The two `pinStageTableRules` calls in the activating transactions are now at `:3051` and `:3889` | `usecases/stages.ts:3051,3889` (T14) |
| P29 | The public standings serve the order's `source` and `pinnedAt` (§13 Smoke, brief Task 14) | `PublicDivisionStandings` serves rows only. `source` and `pinnedAt` come from the authed `GET /stages/{id}` `tableRules`, so the smoke reads them there (an authed read, a deviation from the brief's "public standings") and reads the order from the public route | `api-v1/schemas.ts:1441,1487-1492`; `scripts/smoke.ts:7576-7579` (T14) |

## 5. Engine design

### 5.1 One authority per fact

- **How a match was decided** = the outcome the event fold produced (`fixtures.outcome`, read at
  `competition.ts:371-391`). `decidedIn` is a pure function of that outcome, evaluated at standings time. No new column.
- **What a result pays** = the stage's *effective points rule* (§5.3). The table always applies it. The module's own
  `delta.points` stops being read by any table consumer. For a shoot-out in a draw-plus-bonus sport (B2) the rule also
  sets the W/D/L counts (both sides drawn), because the module's delta books it won/lost today (`football.ts:2721-2730`,
  `period/kernel.ts:2702-2708`). The ledger metrics (`gf`, `sets_won`, `runs_*` …) are still the module's.
- **The order** = the stage's *effective cascade* (§5.4).
- **Effective table rules** are resolved by ONE function. It lives in the engine as `resolveTableRules` (pure), with
  one web loader around it. Every consumer in §6 calls it.

### 5.2 `decidedIn`

`DecidedIn = "regulation" | "ot" | "so"`. It applies only to a `win` outcome. `draw`, `tie`, `no_result`, `award` and
`double_walkover` are outcome kinds and carry no `decidedIn`.

Each sport module declares two things:

- `decidedInOf(method)`. An unknown method string throws `CONFIG_INVALID`. That is a guard, not a comment: every method a
  module can emit is enumerated by the §13.4 sweep.
- `reachableDecidedIn(cfg, stageKind)`, the set the stage's format can produce.
- `shootoutAs: "draw_plus_bonus" | "result"` (B2). Football and hockey (FIH) declare `draw_plus_bonus`: a
  shoot-out-decided table match is a draw for both sides, and the shoot-out winner gets the rule's `soBonus`. Ice hockey,
  cricket (super over) and chess (rungs) declare `result`: the match is a win and a loss, paid `win.so`/`loss.so`.
  In a knockout, the shoot-out only decides who advances (the bracket reads `outcome.winner`, unchanged).

| Sport | Reachable set | Events that prove OT / SO (fold → `outcome.method`) |
|---|---|---|
| football | regulation; `ot` if the stage's `extraTime.enabled`; `so` if `shootout` | `football.period` closing FT/ET → `regulation`/`extra_time` (`football.ts:1024-1038`); `football.shootout.kick` kicks in the SHOOTOUT phase → `shootout` (`:1640-1656`; P27: not `football.penalty`); pad action `pad.football.action.shootoutKick` (`:2351`) |
| ice hockey | regulation; `ot` if `overtime ≠ null`; `so` if `shootout ≠ null` (IIHF default both; recreational neither, `icehockey.ts:194-199`) | `icehockey.period.advance` closing OT → `extra_time` (`period/kernel.ts:1039-1042,1173`); `icehockey.goal` in sudden-death OT (`:1141-1142`); `icehockey.shootout.attempt` → `shootout` (`:1325-1353`); event names `:1904-1910`; pad action `pad.<sport>.action.shootoutAttempt` (`:2087`) |
| hockey (FIH) | regulation; `so` if `shootout ≠ null` (fih-shootout, or stage rules); `ot` if `overtime ≠ null` | the same kernel events under `hockey.*` |
| cricket | regulation (`regulation`, `innings`, `dls`, wickets/runs margins); `so` if the stage's `superOver` (`super_over`, `boundary_count`) | `cricket.ts:966,986,1001,1187,1881,1884,1895` |
| chess / boardgame | regulation; `so` only if a table stage carries tie-break rungs (`tiebreak_<rung>`) | `boardgame.ts:415` |
| volleyball, badminton, table tennis, tennis, carrom, generic | regulation only | `setbased/kernel.ts:556`, `nested/kernel.ts:938`, `carrom.ts:345` (the extra board is a regulation result), `generic.ts:198` |

Mapping: `extra_time` → `ot`. `shootout`, `super_over`, `boundary_count`, `tiebreak_*` → `so`. W2b's `abandoned` win
(a result on the real score, `period/kernel.ts:1476-1494`, `football.ts:1692-1706`) → `regulation`. Legacy
`walkover`/`forfeit` methods on a `win` keep being treated as awards (`points.ts:57-59`). The cricket and chess `so`
mappings are an **author's call** (D4 names regulation/OT/SO, not super over or rungs).

**Pad finding (code read, not driven):** no OT/SO decision in the table above lacks a recorded event. Each one is
folded from an event the module declares, and each has a pad action. Whether the v3 football pad offers kicks in a
GROUP stage that has `shootout` on is not proved by reading. §13 part 5 drives it, and a red there is a W2d defect to
fix, not a premise to assume.

### 5.3 The widened `PointsRule`

Shape (replaces `points.ts:12-38`; greenfield, no shim):

```
PointsRule = {
  win:  { regulation: number, ot?: number, so?: number },   // `so` only in "result" sports
  loss: { regulation: number, ot?: number, so?: number, unplayed?: number },
  draw?: number,        // absent ⇒ this rule covers no draw
  soBonus?: number,     // "draw_plus_bonus" sports only (B2); default 1
  shootoutAs: "draw_plus_bonus" | "result",   // copied from the sport at creation; pinned with the rule
  tie?: number,         // cricket tie; absent ⇒ covers no tie
  noResult?: number,    // absent ⇒ 0 (D14); cricket's default declares 1 (ruling 88)
  bySetScore?: Record<string /* "W-L" | "*" */, [number, number]>,   // set sports; replaces pointsMap for the table
  unit: "whole" | "half",   // display only; "half" ⇒ stored integers are half-points, shown "1½"
  bonuses: Bonus[],         // the `when` enum unchanged
  forfeit?: { winnerPoints, loserPoints, awardScore?: [n, n] }   // W2c X-PT-1, unchanged
}
```

**Payout, one function, applied in this order per decided fixture** (`payout(outcome, decidedIn, pair, played, rule)`):

1. Empty case first: an undecided fixture pays nothing and is not counted.
2. `double_walkover`: 0/0, no bonus (X-DW-4, `points.ts:133-135`).
3. `no_result`: `noResult ?? 0` each.
4. `tie`: `tie` each. `draw` (including a cricket two-innings draw, D10(c)): `draw` each.
5. `award`:
   - A bye pays the forfeit row if one is set, else the clean-sweep win (W2c: a bye never gets `awardScore`).
   - An unplayed forfeit (W2c `isUnplayedForfeit`) pays the forfeit row and its `awardScore` (X-PT-1).
   - Otherwise the winner is paid the win payout of its credited score (ruling 108). The loser is paid `loss.unplayed`
     if the rule declares it (amended 108, D6), else the loss payout of the credited score.
   - Precedence when both are set on an unplayed forfeit: the forfeit row wins (it is the organiser's more specific
     row).
6. `win` with `decidedIn` d:
   - For set sports with `bySetScore`: the pair at the exact `"W-L"` key, else `"*"`.
   - `d = so` under `shootoutAs: "draw_plus_bonus"` (B2): both sides are booked drawn (W/D/L shows D for both) and paid
     `draw`; the shoot-out winner also gets `soBonus` (default 1, so 2/1 with a draw worth 1). The match does not count
     in `wins` for either side.
   - Otherwise the winner gets `win[d]`, falling back so → ot → regulation (the chain `period/kernel.ts:1504-1513`
     uses today), and the loser gets `loss[d]` by the same chain. This is D9's "OT win = win unless split set" and,
     for `result` sports only, the same for SO (IIHF: a GWS pays the OT values, 2/1).
7. Add the bonuses. Margins read the sport's score aliases `DIFF_KEYS`/`FOR_KEYS`/`AGAINST_KEYS`
   (`tiebreakers.ts:237-241`), not literal `diff/for/against`. `validatePointsRule` accepts a margin bonus when the sport
   declares any alias pair. This fixes F11.

**The sport's default, as a rule.** Each module gains `tablePointsRule(cfg, stageKind): PointsRule`, built from its
existing cfg keys. Examples: football `points`; period `otWin/otLoss` (ice hockey); cricket `tie/noResult/draw`; set
`pointsMap`; boardgame `scoring` with `unit:"half"`; generic `w/d/l`. In football and hockey, `shootoutWin/shootoutLoss`
are replaced by one cfg key `soBonus` (default 1; greenfield, no alias). The `fih-shootout` preset's 2/1
(`hockey.ts:144`) becomes draw 1 + `soBonus` 1, which pays the same points and books D instead of W/L. The table then
always applies a rule: the stage's own, or this one. §13.4's parity sweep proves `tablePointsRule` pays exactly what
`standingsDelta` paid before W2d for every sport × variant × reachable outcome. The only allowed differences are the
signed changes: TT 2/1/0 (D6), volleyball best of 3 (D10(a)), the cricket draw default (D10(c)), and the football/FIH
shoot-out booked as a draw plus bonus (B2). Stages pinned by the migration keep their old payouts (B1, §8).

**Reachable outcomes.** `reachableOutcomes(module, cfg, stageKind)` returns a set over `win.{reg,ot,so}`,
`loss.{reg,ot,so,unplayed}`, `draw`, `tie`, `noResult` and, for set sports, every reachable `"W-L"` under `bestOf`. A
rule **covers** an outcome when it pays it directly or through a declared fallback. Fallbacks: ot/so → regulation
(`result` sports); unplayed → the credited score's loss; `noResult` → 0; `soBonus` → 1. `draw` and `tie` have no
fallback, so a rule without them covers no draw and no tie. In a `draw_plus_bonus` sport, a reachable `so` needs `draw`:
a football group stage with shoot-outs on and no `draw` payout is refused (`POINTS_OUTCOME_UNCOVERED`). The points editor
(§9) shows exactly the reachable rows.

**Volleyball and the `"*"` guard (D10(a)).** A `bySetScore` map that pays more than one distinct pair must name every
reachable `"W-L"` explicitly, and `"*"` does not count toward that. A map of one distinct pair, such as `{"*":[2,0]}`, is
flat and always covers. This is the spec's reading of "the guard fires even with `"*"`" (RBS:566). It replaces the early
return at `server/usecases/stage-rules.ts:113` and moves the check into the engine's coverage function, so the stage save,
the division save and the fixture override all ask the same question. Defaults: indoor best of 5
`{"3-0":[3,0],"3-1":[3,0],"3-2":[2,1]}`; indoor best of 3 `{"2-0":[3,0],"2-1":[2,1]}`; beach `{"*":[2,0]}`
(`volleyball.ts:61`, unchanged).

**Chess unit (D10(b)).** The boardgame default stays in half-points (`boardgame.ts:47-55`) with `unit:"half"`. The
Swiss ledger keeps reading half-points (`tiebreakers.ts:723`); W3's values do not move. The 3/1/0 stage preset uses
`unit:"whole"` and is offered only on non-Swiss stages, because D5 says "chess RR" (author's reading). Under 3/1/0,
Sonneborn-Berger and direct encounter still read game points 1/½/0 (B5), never the table points (§5.6).

**Retired:** `POINTS_RULE_INEXPRESSIBLE`, `pointsRuleExpressible` and `BASE_KEYS` (W2c `points.ts:250-277`), with every
reader (§11). Greenfield: deleted, no alias.

**Bounds.** `pointsRuleBounds` (`points.ts:259-283`) is rewritten over the reachable outcomes, so qualification's bounds
(`matchPointsBounds`, `module.ts:868-870`) come from the same rule the table pays.

### 5.4 Per-stage table rules: storage, inheritance, pin, lock

**Storage (greenfield):**

- The stage's own order: `stages.config.tiebreakers: TiebreakerKey[] | null` (null = inherit). It sits beside W2c's
  `stages.config.points` (W2C §4.3). No migration.
- The division default: `divisions.tiebreakers` (`V209__divisions.sql:12`), unchanged.
- The sport default: per stage kind. `defaultTiebreakers` becomes `defaultTiebreakers(kind)`, with the round-robin value
  from §5.10 and the Swiss value unchanged (W3 owns it).
- **The pin:** new columns `stages.table_rules_pinned jsonb null` and `stages.table_rules_pinned_at timestamptz null`
  (§8). Its value is `{ points: PointsRule, tiebreakers: TiebreakerKey[], crossGroup: TiebreakerKey[],
  sources: { points, tiebreakers: "stage" | "division" | "sport" | "migrated" } }`. The pin gets a column, not a `config` key, so no
  `config` merge or `replaceStages` carry can drop it (author's call).
- The stage lots seed: `stages.config.rngSeed` is assigned at stage creation when absent (today it is optional,
  `schemas.ts:1144`).

**Resolution (one function):** `effective = pinned ?? { points: stage.config.points ?? tablePointsRule(division cfg ⊕
stage.rules, kind), tiebreakers: stage.config.tiebreakers ?? division.tiebreakers ?? defaultTiebreakers(kind) }`. The
`sources` field says which layer won. That is what the badge shows.

**Pin at start (D9; orchestrator's call OC2 on the moment).** The pin is written in the same transaction that moves
the stage's status to `active` (`stages.status` is `pending | active | complete`, `V210__stages.sql:10`). Today's writers
are `usecases/stages.ts:2813` and `:3644`. The builder enumerates every writer with `grep -a`, including any insert that
creates a stage already active. The write is idempotent (`… where table_rules_pinned is null`). The invariant "active or
complete ⇒ pinned" is a guard: the resolver throws `CONFIG_INVALID` for such a stage with no pin, and a sweep test drives
every activation path. None may skip the pin.

**Two moments, two effects:**

- **At activation (pin):** division defaults, sport defaults and engine releases stop reaching the stage.
- **Between activation and the first score:** the stage's OWN tie-breaks and points stay editable. Each such save is
  validated and re-writes the pin from the new own value (the badge stays "Pinned at start", source "this stage").
- **At the first score (lock, D3):** the stage's own `tiebreakers` and `points` are refused on save with
  `STAGE_FORMAT_LOCKED` (W2c's code and wording, W2c `stage-rules.ts:150-160`). "First score" is W2c's monotonic
  "played" predicate (`rule-locks.ts:66` `lockedStageIdsAmong` → `playedSql`), so the lock is never undone.

**Migration pin (B1).** The W2d migration pins every stage whose status is `active` or `complete` at migration time to
the rules it uses TODAY, before any new default can reach it:

- **points:** the stage's own `stages.config.points` converted from the old shape (`{base, bonuses, forfeit}`,
  `points.ts:12-38`) to the new one. `base.win/draw/loss` become `win.regulation/draw/loss.regulation`; bonuses and the
  forfeit row are kept; `tie: 0` and `noResult: 0`, because old `applyPointsRule` paid 0 for both (`points.ts:134-146`).
  `shootoutAs: "result"` with no `so` split, because the old rule paid an SO win as a win. With no stage rule, the pin
  is the sport's points as they were paid before W2d (the pre-W2d `tablePointsRule` of the division cfg), including
  SO booked as W/L and TT 2/0.
- **cascade:** `divisions.tiebreakers` if set, else the sport's default list as it stands on main before W2d
  (`defaultTiebreakers`; for badminton `points, wins, set_ratio, point_ratio, h2h_points`,
  `sports/setbased/badminton.ts:56`), written into the migration as literals. Code defaults change in the same release, so the
  migration must not read them.
- `sources` records `"migrated"`. Pinned values are never re-validated against W2d's new save-time rules, because the
  owner's ruling is that no production table moves. One known case: today's badminton order has no `lots`, so the
  production Swiss badminton competition keeps its seed → id fallback (§5.8).
- Old-shape `stages.config.points` on a stage that is still `pending` is converted the same way and stays its own rule.
  New defaults reach it, because nothing has started.

**What changes after the pin:**
- Division saves of `tiebreakers` and of the points keys a stage rule now fully replaces are **no longer refused**.
  They reach only unpinned stages, and the save response lists the pinned stages that kept their rules
  (`stagesKeptPinned`), so nothing is dropped silently.
- W2c's `divisionRefusals` (`rule-locks.ts:91-136`) loses its `tiebreakers` branch (`:113-117`, the "W2d owns per-stage
  cascades" stub).
- W2c's `STAGE_POINTS_REPLACES` (`:43`) widens to every points-scope key the widened rule expresses: `points`,
  `pointsMap`, `otWin`, `otLoss`, `soBonus`, `tie`, `noResult`, `draw` (`shootoutWin/shootoutLoss` are deleted, §5.3).
  Those keys stop raising `DIVISION_TABLE_RULES_LOCKED`.
- The points-scope keys a rule does NOT replace keep W2c's lock (D9 "other W2c settings keep W2c's lock"): boardgame
  `scoring` (it also writes the game headline) and `awardScore` (the goal credit after play).
- A code release that changes a sport default never reaches a pinned stage.

**Fixture override coverage (D9).** W2c's `writeFixtureRulesOverride` (W2c `usecases/fixture-rules.ts`) and the stage
rules save both call `coverage(rule, reachableOutcomes(...))`. The stage save checks the stage's merged format. The
override checks the fixture's merged format against the stage's effective (pinned, if any) rule. An uncovered outcome is
refused with `POINTS_OUTCOME_UNCOVERED`, naming it. The live case is volleyball: a best-of-5 stage on the FIVB map, and
a best-of-3 override makes `2-1`/`2-0` reachable. An override that only removes outcomes (football extra time off) is
always covered.

### 5.5 `validateCascade`

Signature: `validateCascade(cascade, ctx: { module, cfg, stageKind, crossGroup: boolean }): Refusal[]`. It returns
every refusal, not just the first throw, so the editor can mark each step. A refusal is `{ index, key, reason }`. Rules,
empty case first:

1. **Shape.** An empty list is refused, for every stage kind. No key may repeat except `h2h_two`, which may appear
   more than once (OC3, orchestrator's call; the BWF and ATP orders put it after each step). For non-Swiss stages
   only: step 0 must be the sport's primary measure, declared by the module as `primaryTableKey` (`points`, or `wins`
   for volleyball, badminton and tennis; D11 orchestrator's call), and the last step must be `lots`, exactly once.
   **Swiss stages are exempt from the first/last rule** (OC1, orchestrator's call: W3 owns Swiss orders), but rules 2–6
   below still apply to them.
2. **Sport (D10(d)).** Metric-backed keys need the sport's declared metrics (today's checks, `tiebreakers.ts:659-686`),
   plus `set_diff` (sets), `point_diff` (points), `field_goals` (hockey: `gf`, `goals_pc`, `goals_stroke`). `fair_play` needs football with
   `cfg.fairPlay === true` (D8).
3. **Stage format (D10(d)).** `buchholz` and `buchholz_cut1` are valid only on a `swiss` stage, of any sport.
   `sberger` and `direct` are valid on any table stage: on a non-Swiss stage they are computed from pool results (§5.6).
   This is derived from D10(d)'s principle, because the data exists in a round robin.
4. **Cross-group (D3).** With `crossGroup`, every head-to-head key (`h2h_*`, `h2h_two`, `direct`, the h2h modifiers) is
   refused.
5. **Position.** `h2h_reapply` and `h2h_exclusion` must directly follow an h2h block, at most one per block.
6. Unknown keys are refused by the zod enum before this runs.

**Write paths where it runs (each a test):**

- Division create (`usecases/divisions.ts:352`) and patch (`:1091`): against the sport and every UNPINNED table stage
  that would inherit the value. A refusal names the stage and its kind.
- `createStages` / `replaceStages`: against the stage's effective cascade. An inherited key that is invalid for the new
  stage's kind is refused, and the reason tells the organiser to set the stage's own order.
- `PUT /stages/{id}/rules` (W2c `putStageRules`) with `tiebreakers`.
- Template apply (`server/templates/schema.ts:135` stops being `z.array(z.string())`).
- A division cfg save that flips football `fairPlay`: re-validates every unpinned inheriting cascade.
- The bench's `tools/bench/lib/validate-pack.ts:2250-2314` (bench coordination, §11).

A source-scan test enumerates every SQL write to `divisions.tiebreakers` and `stages.config` with `grep -a` and fails
on any writer that does not call the validator.

**Read side.** `rankStandings` throws `CONFIG_INVALID` for a key with no comparator and no structural handler
(replacing the silent skip at `tiebreakers.ts:529-537`).

### 5.6 New keys and their exact semantics

Every key below is from the signed table (D5). Each "rule" cell is the federation text it implements. ✚ marks a key new
to `TiebreakerKey` (`sport/module.ts:46-65`) and to the web enum (`schemas.ts:318-322`).

| Key | Semantics | Rule |
|---|---|---|
| `wins` | more matches won ranks higher (exists, `tiebreakers.ts:334`). Primary for volleyball, badminton and tennis. It counts the W column after the rule is applied, so a draw-plus-bonus shoot-out never counts (B2). Hockey (FIH) additionally declares `winsCount: "regulation"`, so an `ot` win, where a stage enables overtime, does not count either: FIH "matches won" is regulation wins only (B2) | BWF 16.2.1, FIVB V3-1, ATP C.3-1 |
| ✚ `set_diff` | overall `sets_won − sets_lost`, greater first, over all the stage's counted fixtures | BWF 16.2.3 "games difference" |
| ✚ `point_diff` | overall `points_won − points_lost`, greater first | BWF 16.2.4 |
| ✚ `h2h_two` | applies only to a tied class of exactly two; ranks by the points of the matches between them (both legs aggregated in a double round robin, B4). A class of any other size, or two who have not met or are level between them: no split, popover says why. The only key that may repeat in an order (OC3) | BWF 16.2.2/16.2.3.1/16.2.4.1; ATP C.3-3 |
| ✚ `h2h_wins` | inside the h2h block: wins in the mini-table (maps to plain `wins`, extending `h2hToPlain`, `tiebreakers.ts:376-378`) | FIH GTR App. 3 "mini-league, then the earlier keys within it" (RBG:236-237) |
| ✚ `h2h_set_ratio`, `h2h_point_ratio` | inside the h2h block: set ratio and point ratio over the mini-table only | ITTF 3.7.5.2 |
| ✚ `h2h_reapply` | block modifier, re-application after the block: when the block leaves a sub-group smaller than the group it started with, re-run the whole block on matches among that sub-group only, until no progress (today's `h2hRecursive` recursion, `tiebreakers.ts:456-461`; replaces the unreachable `TableStage.h2hRecursive`, F9) | UEFA 20.01(d) (RBG:108-110); IIHF re-application "until ≤2 remain" (RBG:345-346) |
| ✚ `h2h_exclusion` | block modifier, exclusion: as soon as ANY block key splits the group, each resulting sub-group restarts the block from its first key, on matches among its own members only. This differs from `h2h_reapply`, which finishes the block first | ITTF 3.7.5.3 (RBS:228) |
| ✚ `matches_played` | more matches played ranks higher | ATP 4.01 C.3-2 ("a 2–1 record beats 2–0") |
| ✚ `field_goals` | more field goals ranks higher. A field goal is any goal not scored from a penalty corner or a penalty stroke, own goals included (B3): `gf − goals_pc − goals_stroke`, all three already emitted (`period/kernel.ts:1098-1101,2413-2416`). No new metric. The pad's goal type is optional today (`kind?` at `period/kernel.ts:240`; choices `fg, og, …goalKinds` at `:1986`), so an untyped corner goal would count as a field goal: W2d makes the goal type a required pad choice for hockey (FIH) goals (B3), and the engine refuses an untyped `hockey.goal` | FIH GTR App. 3 (RBG:237) |
| `sberger` (outside Swiss) | Sonneborn-Berger over a ledger built from the pool's counted results (`buildSwissTable(entrants, results, awards)`, `tiebreakers.ts:705-748`). A walkover counts as a game (BG-WO-1, signed 86). Opponents' scores are always GAME points (1/½/0), also under a 3/1/0 stage (B5) | FIDE C.07 (RBG:458-459) |
| `direct` (outside Swiss) | unchanged: game points scored among the tied set from pool results (`tiebreakers.ts:482-487`), also under 3/1/0 (B5, author's reading of the same ruling); now accepted by the validator | FIDE C.07 direct encounter |
| `h2h_points` (exists) | points in the mini-table among the tied set. In a double round robin both legs aggregate (B4; volleyball's "last match" wording, RBS:295, is a `deviation` row) | FIVB V3-1, FIFA, FIH |
| `lots` | the stored draw, §5.8 | ruling 70; D5 |

**ST-G12 partial schedule.** The h2h block gets a guard. A tied class's mini-schedule is *complete* when every fixture
the stage schedules between members of the class is decided (counted from the stage's fixtures, passed in as
`RankContext.scheduledPairs`).

- When the schedule is incomplete, a sport that declares `partialScheduleOrder` uses that order for the class instead of
  the block. IIHF declares fewest games played → `diff` → `for` → `seed` → `lots` (RBG:349-350). "Fewest played" is an
  internal comparator; it is not offered in the editor.
- **Author's call:** every other sport skips the block for that class (no split, popover "head-to-head not complete"),
  so a team is never placed above a rival it has not yet played (AUD-ST:71 G12). D7 names only the IIHF order, so this
  generic half is flagged for the owner (§17).

`h2h_scope:"overall"` (`tiebreakers.ts:421`, API-only, gated `stages.ts:425-427`) is unchanged.

### 5.7 Display columns

`competition/display.ts` and `server/public-site/standings-view.ts:370,391` (`standingsColumns`) derive the columns
from the effective cascade, so each new key needs a column and a label (`lib/tiebreak-label.ts:21`, four locales):
set difference, point difference, field goals, SB (round robin), and tennis game ratio (ST-G29, which shows once it is in
the order).

- **IIHF** prints `OTW`/`OTL`. A display-only fold of `decidedIn` counts gives row metrics `won_ot`, `won_so`, `lost_ot`
  and `lost_so`; the IIHF columns sum OT+SO (RBG:343-344). Recreational prints GP W D L.
- **Chess** `unit:"half"` renders `pointsToText` (`tiebreakers.ts:180-185`), so 3 half-points prints "1½".
- An **empty table** (zero counted fixtures) renders every rank as "–" and suppresses leader styling and qualification
  chips (anti-goal 3).

### 5.8 Stored lots draw (D5, ruling 70)

The engine stays pure:

- `RankContext` gains `lotsDraws: ReadonlyMap<membersKey, EntrantId[]>`. `membersKey` is the sorted entrant ids of the
  tied class, joined.
- `RankingResult` gains `newLotsDraws`.

When the cascade reaches `lots` with a residual class:

1. Empty case: if the stage has zero counted fixtures, draw nothing. Order by seed then id, flag `level`, store nothing.
2. If `lotsDraws` holds the class's exact member set, use that order.
3. Otherwise draw with the seeded shuffle `shuffle(lotSeed(stage rngSeed, ids))` (`tiebreakers.ts:547-556,585-598`) and
   return the draw in `newLotsDraws`.

The web recompute (`competition.ts:545-559`, `:577-588`, `:630+`) persists `newLotsDraws` under the division advisory
lock it already holds. A draw is keyed by membership, so the order is the same on every reload. If the same two
entrants tie again later, they get the same order. If the tied set changes, a new draw is made and the old row stays as
history.

At completion, the `rank_lock` division event (`stage.ts:104-105`, appended at `competition.ts:788-789`) gains
`order: EntrantId[]` and `drawnAt`. The popover shows "Drawn by lots on {date}".

The no-`lots` seed → id fallback (`tiebreakers.ts:599-607`) becomes unreachable through validated NON-Swiss cascades
(rule 1 of §5.5). It stays reachable for Swiss orders that do not end in `lots` (OC1; today's badminton Swiss order,
which the production competition is pinned to, B1) and for unvalidated engine callers (testkit, bench). A test proves
no non-Swiss product path reaches it.

**W3 base (D7):** the Swiss stage gets the same storage. Ruling 70's cross-run nondeterminism (UUIDs differ between
harness runs) is not fixed by storage. §16 names that risk.

### 5.9 Cross-group ranking (ST-G4)

`progression.ts:573-575` `crossGroupOrder` takes the SOURCE stage's effective `crossGroup` order and its stored lots
draws, instead of the hard-coded list. Its callers are qualification `orderCandidates` and `stage-seeding`
`crossGroupOrder` (the comment at `progression.ts:570-572`).

The `crossGroup` order defaults to the stage's order with every head-to-head key removed. It is pinned with the stage
(§5.4). The API accepts an explicit `crossGroupTiebreakers`, validated with `crossGroup:true`, so D3's "H2H on a
cross-group table" is refused where it can actually be submitted.

**Author's call:** the editor shows the cross-group order as one read-only line under the list ("Between groups:
Points → GD → … → Lots"). D11 describes one list, so a second editable list is not built. Unequal pool sizes (ST-G3)
stay W5's.

### 5.10 Per-sport defaults (D5 signed, D10)

These are the round-robin, league and group defaults. They reach only stages not yet active (B1, OC2). Swiss defaults
are unchanged and exempt from the first/last shape rule (W3; OC1). "Deviation" rows go to
`packages/engine/rules/` with status `deviation <ruling> <date>` (ruling 75).

| Sport | Points default (stage presets) | Default order | Deviation rows |
|---|---|---|---|
| football | W 3, D 1, L 0. A group shoot-out is a draw plus a bonus: both D (1), the winner +1 (`soBonus`), so 2/1 (B2) | `fifa2026`: points, h2h_points, h2h_diff, h2h_for, diff, for, fair_play, lots. Presets: `uefa` = fifa2026 with `h2h_reapply` after the block; `classic` = points, diff, for, h2h_points, h2h_diff, h2h_for, fair_play, lots (`football.ts:1769-1775`) | lots instead of FIFA ranking (RB2B-4); UEFA 20.02 not offered (RB2B-5); UEFA Art. 20.01 criteria after overall goals are not modelled, so the `uefa` preset's tail is fifa2026's (INFERRED from RBG:111-112, which names only re-application) |
| hockey (FIH) | 3/1/0 with draws (D10(f)). Preset "Pro League": every drawn match goes to a shoot-out, booked D 1 each, winner +1 (`soBonus`), so 2/1; regulation W 3, L 0 (`fih-shootout`, `hockey.ts:141-145`, re-expressed per B2). `wins` counts regulation wins only (B2) | points, wins, diff, for, h2h_points, h2h_wins, h2h_diff, h2h_for, field_goals, lots (RBG:236-237) | lots instead of the FIH ranking shoot-out (RB2B-11) |
| ice hockey | IIHF: regulation W 3, OT/GWS W 2, OT/GWS L 1, regulation L 0. Recreational 2/1/0 with draws (`icehockey.ts:169,194-199`) | points, h2h_points, h2h_diff, h2h_for, h2h_reapply, diff, for, seed, lots. Partial-schedule order: fewest played, diff, for, seed, lots (§5.6) | IIHF steps 4–5 skipped (RB2B-12); lots after seed |
| chess / boardgame | 1 / ½ / 0 in half-points, shown "1½". Preset 3/1/0 on non-Swiss stages | points, direct, wins, sberger, lots. No Buchholz outside Swiss (C.07 Art. 8 note) | none. SB and direct read game points under 3/1/0 (B5) |
| cricket | W 2, tie 1, NR 1, L 0; tie and NR editable; two-innings draw 1, only when `inningsPerSide === 2` (D10(c)) | points, wins, nrr, h2h_points, seed, lots (`cricket.ts:4019` + lots) | lots after seed (ICC stops at pre-event ranking, RBS:454) |
| volleyball | indoor best of 5 FIVB 3-0/3-1 ⇒ 3:0, 3-2 ⇒ 2:1; best of 3: 2-0 ⇒ 3:0, 2-1 ⇒ 2:1 (D10(a), product rule, FIVB silent); beach `*` 2:0 | wins, points, set_ratio, point_ratio, h2h_points, lots (RBS:291-296) | best-of-3 points (FIVB silent, VB-12); double-round-robin H2H aggregates both legs (B4; RBS:295 says the last match); lots |
| badminton | flat 2/0 (unchanged; BWF has no table points, RBS:150) | wins, h2h_two, set_diff, h2h_two, point_diff, h2h_two, lots (RBS:151-156) | none |
| table tennis | W 2, played L 1, unplayed L 0 (D6) | points, h2h_points, h2h_set_ratio, h2h_point_ratio, h2h_exclusion, lots (RBS:227-230) | none |
| tennis | W 2 / L 0 (unchanged, `tennis.ts:25`). A won match tie-break counts as one set and one game (RB2A-11) | wins, matches_played, h2h_two, set_ratio, h2h_two, game_ratio, h2h_two, seed, lots | lots after seed (ATP stops at ranking) |
| carrom | 2 / 1 (house draw) / 0 | unchanged: points, wins, set_ratio, board_ratio, point_ratio, h2h_points, lots | product rule (RB2B-27) |
| generic | 3/1/0 | unchanged: points, diff, for, h2h_points, lots | product rule |

The tennis order puts `h2h_two` after each step. That is the spec's reading of ATP C.3's "at each step a single
superior or inferior player leaves the other two to be settled by head-to-head" (RBS:370-371), consistent with D5's
"wins > played > H2H2 > set% > game% > seed".

The tennis MTB rule touches the nested kernel ledger. It is a W2d-moved line under MD-1; the older nested-kernel
survivors stay W2e's.

## 6. Consumers of standings and the order (code-facts §6) and what changes

| # | Consumer | Today | W2d change |
|---|---|---|---|
| E1 | `competition/stage.ts:215-265` `completeTableStage` | ranks with `stage.cascade`, `h2hRecursive`, `rngSeed` | takes `tableRules` (points, cascade, crossGroup, lotsDraws, scheduledPairs); returns `newLotsDraws`; `rank_lock` carries `order`; `h2hRecursive` removed |
| E2 | `competition/progression.ts:570-575` | hard-coded order | the source stage's crossGroup order + lots (§5.9) |
| E3 | `competition/tie-what-if.ts:54-60` | null unless `cascade[0]==="points"` | reads `primaryTableKey`; wins-first sports get a what-if |
| E4 | `competition/display.ts` | columns from the cascade | new key columns, OTW/OTL, half-point unit |
| E5 | `competition/points.ts` | stage rule only | the widened rule always applied (§5.3); a draw-plus-bonus shoot-out rewrites W/L to D/D (B2) |
| E6 | `testkit/simulation.ts:559,653` | `deriveSeed(…,"lots",stageId)` | passes effective rules and a lots map |
| W1 | `server/engine-db/competition.ts:358,394,454-482,545-588,630+` | division cascade; rule only if the stage has one | `resolveTableRules` (pin first, for active/complete stages); the rule always applies; persists lots; `h2h_scope` kept. The pin is written by the activation writers (§5.4), not here |
| W2 | `server/public-site/competition-hub.ts:920` | own resolver | the one resolver, per stage |
| W3 | `server/slideshow-data.ts:71` | own resolver | the one resolver |
| W4 | `app/embed/divisions/[id]/[widget]/page.tsx:72` | own resolver | the one resolver |
| W5 | `app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:95` | own resolver | the one resolver |
| W6 | `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:440,955-969` | own resolver + read-only division caption | per-stage caption with source/pinned; the editor lives in the stage card (§9) |
| W7 | `server/public-site/standings-view.ts:370,391`, `division-qualification.ts:53`, `qualification-view.ts:152,317` | cascade + module bounds | effective rules; bounds from `pointsRuleBounds` |
| W8 | `components/public-site/standings-table.tsx:161-164`, `lib/tiebreak-label.ts:21` | popover with old keys | new key labels, "Drawn by lots on…", "head-to-head not complete", "level" |
| W9 | `api/v1/stages/[id]/standings` (+`/override`), public `…/divisions/[divisionSlug]/standings` | rows | rows + `won_ot/won_so/lost_ot/lost_so`, `tieBreak.drawnAt`, `level` |
| W10 | recompute triggers `usecases/scoring.ts:972`, `stages.ts:2287,2876,4972,5030`, `admin-fixture-config.ts:381` | unchanged | unchanged (they all go through W1). **Amended 2026-10-27 (Concern 2, programme ruling 217):** the triggers gain the generate and a seed confirm (`REAL_TABLE_KINDS`, `emptyFold: "skip"`), and a roster delete and Unpair (`"drop"`); the export skips level and empty tables. Programme decision log, W2d entry |
| W11 | Swiss `buildSwissTable` (`tiebreakers.ts:723`) | reads post-rule `delta.points` | unchanged values for the defaults (parity sweep); 3/1/0 never offered on Swiss. Round-robin SB/direct read game points, not table points (B5) |
| W13 | stage activation, `usecases/stages.ts:2813,3644` | `status = 'active'` | writes the pin in the same statement's transaction (§5.4, OC2) |
| W14 | hockey pad goal action (`period/kernel.ts:1986`) | goal type optional | goal type required for hockey (FIH) (B3) |
| W12 | W2c `usecases/rule-locks.ts`, `stage-rules-merge.ts:233,262,287`, `lib/rule-errors.ts:20,96-104`, `stage-defaults.ts`, `api-v1/openapi.ts`, `components/v2/stage-rules/stage-points-section.tsx:173` | Q3 lock and inexpressible refusal | §5.4 pin; inexpressible deleted |
| B1 | `tools/bench/lib/validate-pack.ts:2250,2284,2314`, `tools/bench/lib/pack-template.ts:107` | own resolver | coordinated with the bench index before any edit (`_RULES.md` R3) |
| B2 | `tools/matrix/lib/browser/pages/standings.ts` | reads the table | re-checked against the new columns |

## 7. API v1 and OpenAPI

Greenfield (W2C:351-353): shapes change without a deprecation window. Tests that pin old shapes are updated.

- `TiebreakerKeyS` (`schemas.ts:318-322`) gains the ✚ keys in §5.6.
- Division create/patch `tiebreakers` is validated (§5.5). The patch response adds `stagesKeptPinned: {stageId, name}[]`.
- `PUT /stages/{id}/rules` (W2c) accepts `tiebreakers: TiebreakerKey[] | null` and `crossGroupTiebreakers`. `points`
  takes the widened `PointsRule` or `null`.
- `createStages`/`replaceStages`: `config.tiebreakers` is validated. `rngSeed` is assigned server-side when absent.
- GET stage/stages gains `tableRules: { tiebreakers: {keys, source, pinnedAt}, crossGroup: {keys}, points: {rule,
  source, pinnedAt}, reachableOutcomes }`. `source` includes `"migrated"` (B1).
- `PointsRule` in the schema gains `soBonus` and `shootoutAs`; football/hockey cfg `shootoutWin/shootoutLoss` are
  removed in favour of `soBonus` (B2).
- Standings rows, see W9.
- Error codes: §10. `POINTS_RULE_INEXPRESSIBLE` is removed from the schema and the error map.
- OpenAPI is regenerated. CI's drift check (a `ci.yml` step) must pass, so the regenerated spec is committed in the
  same PR.

## 8. Migrations

One delta, number = main's max+1 **at rebase** (D1). Expected landing order: W2c (its V463 needs renumbering past
main's V467, P6), then r2's V468, then free-stages' V469 (D2), so W2d is **V470 provisional**. Whoever lands second
renumbers.

- `stages.table_rules_pinned jsonb null`, `stages.table_rules_pinned_at timestamptz null`.
- `stage_lots_draws`:
  - columns: `id uuid pk`, `stage_id uuid not null references stages on delete cascade`, `pool_id uuid null`,
    `members_key text not null`, `members uuid[] not null`, `drawn_order uuid[] not null`, `seed bigint not null`,
    `drawn_at timestamptz not null default now()`, `superseded_at timestamptz null`;
  - a unique partial index on `(stage_id, coalesce(pool_id,…), members_key) where superseded_at is null`;
  - tenant RLS like its sibling stage tables. Load the `supabase-postgres-best-practices` skill before writing it.
- No `decidedIn` column (it is derived, Q4 note).
- **Data step (B1)**, in the same migration, after the DDL: for every stage with `status in ('active','complete')`,
  write `table_rules_pinned = {points, tiebreakers, crossGroup, sources:"migrated"}` and `table_rules_pinned_at =
  now()`, with the values defined in §5.4 "Migration pin": the stage's converted own rule or the pre-W2d sport points,
  and `divisions.tiebreakers` or the pre-W2d sport default list written in as SQL literals per sport. For every stage
  (any status) whose `config.points` has the old shape, rewrite it to the new shape. The step is idempotent
  (`where table_rules_pinned is null`; the shape test keys on `config.points ? 'base'`). Football and hockey division
  cfgs carrying `shootoutWin/shootoutLoss` get `soBonus = shootoutWin − draw` and lose the old keys; a started stage
  of theirs is already pinned with its old W/L payout.
- **Production fact (owner, B1):** production holds exactly one competition, a Swiss badminton one. Its stages are
  pinned to the order they rank by today: `divisions.tiebreakers` if set, else `points, wins, set_ratio, point_ratio,
  h2h_points` (`sports/setbased/badminton.ts:56`; INFERRED that the Swiss stage resolves to this list, the builder
  confirms against the live row), and flat 2/0, so its table does not move. The builder reads the live row count before and after the migration on staging and
  records it in the PR.
- The migration test (§13.8) proves order identity on a started stage.

## 9. UI (D11 Option A; correctness-first, existing pattern)

**Placement.** A new "Tie-breaks" section in the stage card's rules editor (W2c S1, `stages-panel.tsx`
`StageFormatRow`), after W2c's "Points" section (`stage-points-section.tsx`, mounted at W2c `stages-panel.tsx:2504`). It
appears on table stages only (league, group, swiss, americano).

**The list:**

- Numbered rows.
- Row 1 is the sport's primary measure, pinned: no arrows, no remove, hint "always first" (orchestrator's call).
- The last row is "Drawing of lots", pinned, hint "always last".
- Middle rows have ↑/↓/remove.
- "+ Add step" offers only keys `validateCascade` accepts at that position for this sport, stage kind and context. The
  h2h modifiers are offered only directly after an h2h step.
- "Reset to sport default". **Author's call:** for football it is a small menu (FIFA 2026 / UEFA / Classic), because D5
  signs three presets.
- A pooled stage with best-Nth progression shows the read-only cross-group line (§5.9).

**Badge** beside the section title:

- *Inherited*, with the source "from the division" or "sport default".
- *Overridden*, when it is this stage's own.
- *Pinned at start*, from the moment the stage is active (OC2), with the source it was pinned from (division, sport
  default, this stage, or "before this update" for a migrated pin).

**Errors.** A `TIEBREAK_KEY_INVALID` refusal renders inline next to the offending step with its reason. An inherited
division default that is invalid for this stage kind shows the error on the inherited step, plus a one-line hint to set
this stage's own order.

**Lock.** Between activation and the first score the stage's own order stays editable (§5.4). Once the stage has a
score: arrows, remove, add and reset are hidden, and one 🔒 line reads "{stage} has
started — its tie-breaks are pinned." (W2c S4 pattern). The server refusal `STAGE_FORMAT_LOCKED` is the backstop.

**Points section (W2c S3, widened):**

- It shows exactly `reachableOutcomes`: "A win [3] · in overtime [same as a win] · a loss [0] · …". A shoot-out row
  reads, in football and hockey (FIH), "after a shoot-out: counts as a draw; the winner gets +[1]" (B2), and in ice
  hockey "won after a shoot-out [2] · lost after a shoot-out [1]". There is a draw row only if a draw is reachable, tie and no result for cricket, and "a loss not
  played" for TT.
- Volleyball shows a row per reachable set score.
- Preset chips: chess 1/½/0 vs 3/1/0 (non-Swiss), hockey "Pro League" (draw 1, shoot-out winner +1).
- Hockey (FIH) pad: the goal sheet asks the goal type (field goal, penalty corner, penalty stroke, own goal) before it
  commits (B3). This is a pad change, so its own e2e and the phone composition rules (AGENTS.md) apply.
- W2c's inexpressible card is deleted.

**Public table:** chess "1½"; IIHF OTW/OTL; new columns; lots note; the empty table shows "–" ranks (§5.7).

**Copy.** Every new string goes into `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then run `pnpm
i18n:gen-keys`. The families are: `div.detail.tiebreak.rule.<key>` for every ✚ key and modifier; editor chrome (badges,
add step, reset and preset names, always first/last, the lock line, the cross-group line); the §10 messages; the
points outcome rows; the lots note; the empty-table note. Canonical English field labels follow W2C §4.1.

**Bar.** Owner 2026-10-19 and D1: correctness first, no polish passes. Sign-off screenshots at **1280 only**. The e2e
spec runs at all seven width projects (`mobile.spec.ts` matrix), with no horizontal scroll. Every UI task invokes the
`frontend-design` skill and builds in the house theme.

## 10. Error handling

One code, one wording, on screen and in the API, in all four locales.

| Code | When | Organiser message |
|---|---|---|
| `TIEBREAK_KEY_INVALID` (new, 422) | `validateCascade` refusal; `extra: { refusals: [{index,key,reason}] }` | "{step} can't be used here: {reason}". Reasons: `sport` "this sport doesn't record it"; `stage_format` "only in Swiss stages"; `cross_group` "teams in different groups never played each other"; `fair_play_off` "fair play isn't tracked in this division"; `position` "must come right after the head-to-head steps"; `first` "the order must start with {primary}"; `last` "the order must end with a drawing of lots"; `duplicate` "already in the order"; `empty` "add at least one step" |
| `POINTS_OUTCOME_UNCOVERED` (new, 422) | a stage rules save or fixture override makes an outcome reachable that the rule does not cover | "This stage can end {outcome} ({e.g. 2-1}), and its points don't say what that pays." |
| `STAGE_FORMAT_LOCKED` (W2c) | a stage's own tie-breaks/points after its first score | "{stage} has started — its rules are locked." |
| `DIVISION_TABLE_RULES_LOCKED` (W2c) | now only for `scoring`/`awardScore` (§5.4) | unchanged |
| `CONFIG_INVALID` (exists) | engine guards: unknown `decidedIn` method, a key with no comparator, active-but-unpinned, an untyped hockey goal | engine reason (never shown to an organiser in a passing build) |
| `POINTS_RULE_INEXPRESSIBLE` (W2c) | **retired** | — |

## 11. Coordination with W2c (f-w2c)

1. **W2c merges first** (D1). W2d rebases onto it and re-pins every W2c citation in this spec. If W2c's V463 is
   renumbered, W2d follows.
2. **`shootoutWin`/`shootoutLoss` handover (D10(e), B2).** W2c lists them as "points" scope keys edited on its ST-G8
   screen (W2C §4.1 Q5 list). In W2d they are replaced by `soBonus` (football, hockey), because a shoot-out there is a
   draw plus a bonus, and are removed from the stage-rules allowlist and the division cfg. Ice hockey keeps
   `otWin/otLoss`, which `tablePointsRule` reads as the sport default. f-w2c is told before
   W2d's plan is approved, as a recommendation from f-w2d, not as an owner ruling (class 17).
3. **`points.ts` under MD-1.** W2c owns it (W2C:344). W2d classifies only the lines it moves or adds there (§14).
4. **The Q3 lock loosens into the pin (§5.4):** `divisionRefusals`' tiebreakers branch, the widened
   `STAGE_POINTS_REPLACES`, and `division-settings-locks.ts:18`'s UI reading of locked fields. W2c's
   `rules-lifecycle-sequence.test.ts` and `division-locks.test.ts` are rewritten, not worked around. Each rewrite says
   why in its commit.
5. **`tools/matrix/__tests__/product-gates-source.ts` (W2c).** It reads the stage-batch gates by following
   `assertStageBatchGates`. W2d adds no gate. All scoring is free (D1), so W2d also proves a community org can save a
   stage cascade, a split points rule, bonuses and a forfeit row. The `standings.custom_points` and `tiebreakers.custom`
   gates (`stages.ts:418-427`) are seeded true for community at `V393__entitlements_v18.sql:63-69`. The live catalog
   is re-verified at build, because memory records that it has differed from the migrations. If any plan reads false,
   the `requireFeature` calls for scoring settings are removed (D1). The free-stages PR (D2) edits other gates in the
   same function; the two PRs touch disjoint lines.

## 12. Boundaries

1. **W2e.** W2d edits sport-module lines only where §5 names them: `tablePointsRule`, `decidedInOf`,
   `reachableDecidedIn`, `primaryTableKey`, `partialScheduleOrder`, `goals_fg`, the tennis MTB game and the defaults.
   The older survivors in those files stay W2e's (MD-1). Continuous sudden-death OT (SC-P3) changes the OT outcomes that
   exist, not what they pay. W2e adds any new OT mode to `reachableDecidedIn` and gets coverage for free.
2. **W3.** SW-H4 builds on W2d's validator and editor. W3 owns Swiss default content, the Buchholz bye fix (F12) and
   P6. W2d's stored lots are W3's base (ruling 70).
3. **W5 brief amendments (D7)**, made in the same PR as this wave's fold:
   - `W5-round-robin.md:79-80`: the trap "Residual ties fall to seed then UUID (ST-G13)" becomes "fixed in W2d (stored
     lots)".
   - `2026-09-27-format-matrix-design.md:455` W5 row: drop ST-G4 and ST-G13.
   - `_INDEX.md:3869-3872`: ST-G4, ST-G12 and ST-G13 → W2d. ST-G3 stays W5.
4. **Free stages PR** (D2): migration order only (§8).
5. **Division builder and settings redesign** after W2. W2d adds no division-level cascade editor.

## 13. Testing (the owner's seven-part design, plus the migration test, smoke and regression)

House rules apply throughout: `TEST-STRATEGY.md` rules 1–10; `_RULES.md` R9, R13, R15–R19, R25–R29; scoped local runs
only. **Every expected value comes from the rulebook text or the engine's own declarations, never from the code under
test.** Every sweep and property returns its count, and zero checked is a failure.

1. **Rulebook scenarios per sport.** For every sport and default (§5.10), a table written from the rule text, with a
   case that each key DECIDES and one DIFFERENTIAL case where today's order gives a different answer. Each case is
   linked to its `rules/` row id in the test title. Required differentials:
   - VB-9: five 3-2 wins (10 pts) above four 3-0 wins (12 pts) (RBS:318).
   - BWF: a three-way tie split by games DIFFERENCE where the ratio disagrees.
   - TT: a walkover loser on 0 vs a played loser on 1, and an exclusion case where restarting on the remaining two
     reverses the 3-way ratio order.
   - Tennis: 2-1 above 2-0 (matches played).
   - FIH: more wins above better GD; field goals deciding.
   - IIHF: a 4-way tie re-applied down to 2, and a partial-schedule case.
   - Football: `uefa` vs `fifa2026` on a 3-way tie that re-application splits differently.
   - Chess RR: SB deciding where Buchholz would have.
   - Cricket: a tie under a stage rule pays 1, not 0 (ST-G9).
   - Volleyball best of 3: 2-1 pays 2:1, not 3:0 (SC-S9).
   - Cross-group (ST-G4): two badminton runners-up split by `set_diff`, not by seed.
   - SC-P4 oracle (D10(f)): FIH default 3/1/0 with a draw; a shoot-out case on the Pro League preset (D 1 each, winner
     +1).
   - Shoot-out as draw plus bonus (B2): a football group shoot-out books D for both sides, 2/1 points, and no `wins`;
     the differential is today's W/L booking. Ice hockey GWS still books OTW/OTL.
   - FIH "matches won" (B2): two teams level on points, one with a shoot-out bonus win, the other with a regulation
     win; `wins` separates them toward the regulation winner.
   - Field goals (B3): an own goal counts, a corner and a stroke do not; expected values from the FIH App. 3 text.
   - Volleyball double round robin (B4): the aggregate of both legs decides where the last match alone would not.
   - Chess under 3/1/0 (B5): SB computed from game points differs from SB computed from table points.
2. **Edge cases per key:**
   - an empty table: no leader, no lots stored;
   - one entrant;
   - `h2h_two` twice in one order is accepted, and any other key twice is refused (OC3);
   - a Swiss order that does not start with the primary measure or end in `lots` is accepted, while a Swiss order
     with a non-Swiss key (e.g. `buchholz` outside Swiss, `nrr` in badminton) is still refused (OC1);
   - all level down to lots;
   - two-, three- and four-way ties;
   - `h2h_two` on a class of 3, and on two who never met;
   - re-application with no progress (it must terminate);
   - exclusion after the first split;
   - a walkover, a double walkover (0 points, out of every ratio, X-DW-4), a retirement and an abandon with and without
     a result, per W2b rulings 85/86/88/108-amended;
   - a void, then the table again;
   - a second recompute;
   - a stage with pools.
3. **fast-check properties**, each with named seed regressions committed BEFORE any fix (R29):
   - permutation invariance: shuffling row and fixture order gives the same ranking, given the same lots map;
   - lots reload stability: recompute twice, persist, recompute again, and the order is identical; an unrelated result
     that leaves the tied set the same keeps the draw;
   - appending a key never reorders entrants the prefix already separated;
   - points conservation: Σ row points = Σ per-fixture payouts under the effective rule, and a double walkover adds 0;
   - pin monotonicity: no sequence of division/sport edits after activation changes a pinned stage's rows.
4. **`forEachSport` sweep** (`testkit/for-each-sport.ts`), over every sport × variant × table stage kind:
   - the default order passes `validateCascade`; for Swiss the shape rule is skipped (OC1) and the key and format
     checks still run, and the count of Swiss cells checked is reported separately;
   - every key "+ Add step" offers passes, and every key it hides is refused (the complement);
   - `tablePointsRule` covers `reachableOutcomes`;
   - the parity of `tablePointsRule` against `standingsDelta`, except for the signed changes;
   - `decidedInOf` is total over every method the module can emit;
   - each check reports its count, and 0 fails.
5. **Real producer → consumer** (class 1). Pad events go through the real `POST /api/v1/fixtures/{id}/events`, then the
   recompute, then `GET` the public standings:
   - football group stage with shoot-out on: `football.shootout.kick` kicks (P27) → `won_so`, the public row shows D for both and
     the winner's 2 points (B2);
   - hockey (FIH) goal through the pad with a goal type → `field_goals` (B3), and a goal without one refused;
   - IIHF: `icehockey.period.advance` into OT + `icehockey.goal` → OTW/OTL and 2/1;
   - `icehockey.shootout.attempt` → GWS 2/1;
   - cricket tie → 1 point each;
   - TT walkover → loser 0.
   The pin is proved through the real activation writers (`stages.ts:2813,3644`), and the lock through the real
   first-event append; the fixture override refusal through the real `PUT /fixtures/{id}/rules`.
6. **MD-1 Stryker** (§14). Every survivor is classified, with before and after scores.
7. **e2e via CI dispatch only** (never local; `gh workflow run e2e.yml --ref feat/format-matrix-w2d`):
   - one stage-editor spec run whole (no `-g`) at all seven widths: inherit → override → invalid step error → reset →
     first score → pinned and locked; it opens any phone fold before asserting;
   - one walkthrough per sport family: goals (football/hockey/ice hockey), sets (volleyball/badminton/TT), tennis,
     cricket, boards (chess, carrom), generic. Each sets an order, scores through the pad, and reads the public table
     order and columns.
   - axe on the new section.

8. **Migration (B1).** On a DB at main's head with W2d's earlier migrations applied, seed one active and one
   complete stage per sport family (including a Swiss badminton one mirroring production, an old-shape
   `config.points`, and a football stage with a played shoot-out), record each stage's public table order and points,
   apply the W2d migration, recompute, and assert the order and points are IDENTICAL row by row. The count of stages
   compared is reported and zero fails. A pending stage in the same DB DOES take the new default (the positive pair).
   Mutate once: skip the pin step, and the test must go red on the football shoot-out stage.

**Smoke** (`scripts/smoke.ts` pattern, runs on the PR): create a division, set a stage order and points through the API,
score one fixture, then read the public standings (order, source, pinned).

**Regression:** one test per closed gap id (ST-G2/G4/G9/G10/G12/G13/G16/G29, SC-P10, SC-S9, F11, P20–P25), each red
on main before its fix.

**Mutate the guard once** (rule 5): the first/last shape check, the fair-play cfg check, the cross-group refusal, the
coverage function, the active⇒pinned guard, the `h2h_two`-only repeat allowance, the Swiss shape exemption, the no-comparator throw and the empty-table no-lots rule. Each is mutated
by hand, one at a time, and a named test must fail.

**Reviewer's four questions** are answered in writing for every task: a second call, an empty input, after a withdrawal
or void, another sport.

## 14. MD-1 mutation ownership

- **`competition/tiebreakers.ts`:** W2d owns every survivor (IDX:3507). Baseline W1d is 197 survivors, 503 killed,
  13 timeout of 713 mutants, ≈72.4% (`truth-runs/w1d-baseline/MUTATION.md:174-177`). Legs: competition-6/-7, split at
  `directRefine` (`stryker.groups.mjs:35,91-94`).
- **`competition/points.ts`:** moved to W2c (P13). W2d classifies the lines it adds or moves (the rewrite in §5.3 is
  most of the file). The W1d baseline is stale (W2c changed +140/−21), so the "before" score is re-measured on main
  after W2c merges.
- **`progression.ts`, `stage.ts`, sport-module lines:** W2d's moved lines only. The rest follows MD-1's table (W2c for
  `stage.ts`/`progression.ts` if W2c edited them; W2e for the modules).
- **Method:** `pnpm exec stryker run --mutate "<file>[:lines]"` from `packages/engine`, never group=all locally.
  Survived and NoCoverage are both recorded. Escalate above 150 survivors in one run (W2c's form). Classes are A-real
  (killing test, expected value from the rulebook), A-msg, B-equivalent (`stryker-equivalent.json` + proof) and C-dead
  (caller search named). Treat static survivors as suspect until P0 lands (IDX:3515-3516).
- **Floors:** `stryker-floor.json` competition 77.9 is never lowered. The PR body carries per-file counts and the
  before/after score. CI's group=all after merge is the cross-check.

## 15. Delivery

1. Owner approves this spec → plan (writing-plans), with Appendix A rows worded for signing → owner approves the plan
   and the execution method.
2. After W2c merges: fresh worktree `feat/format-matrix-w2d` off main. Re-pin every citation. Migration = max+1.
3. Build task by task: implementer → reviewer loop. Opus-minimum unless the owner extends the Sonnet exception
   (RULES.md:56-75; INFERRED that it does not cover W2d today). Several tasks touching the same files are batched inline.
4. Fold: D1–D11 get ruling numbers after W2c's. The ruling 108 amendment text (§3), §4's false premises, the W5
   amendments (§12.3), and the MD-1 table row for `points.ts` (P13) go into `_INDEX.md`. Rows go into
   `packages/engine/rules/` with their statuses.
5. One PR, merge commit. Smoke runs on the PR. e2e by `workflow_dispatch --ref feat/format-matrix-w2d` before merge.
   Stryker legs are dispatched. A whole-branch review runs before merge. Merge only on the owner's explicit go.

## 16. Risks

- **The table always applies a rule now (§5.1).** A parity miss would change points silently in every sport. Mitigated
  by the §13.4 parity sweep, which enumerates every sport × variant × reachable outcome, and the signed-delta allowlist.
- **More cascades end in `lots` (badminton, TT, volleyball, cricket, tennis, both hockeys).** Ruling 70's harness
  effect, where tied Swiss entrants reorder per run because UUIDs differ, can spread to more `swiss_knockout` L3 cells.
  Dispatch one judge regression and record any new P6 cell against ruling 70 rather than parking it.
- **Six cascade resolvers collapse to one**, and the per-division caption becomes per-stage. A source-scan test guards
  any regrowth.
- **Pin write paths.** Missing an activation path leaves a stage unpinned. The active⇒pinned guard throws, and §13.5
  drives each path.
- **The migration pin (B1).** A wrong literal in the data step would move a started table, which is the thing B1
  forbids. §13.8 compares orders before and after, and the staging run is checked before production. Production holds
  one competition, so the blast radius is small but not zero.
- **Making the hockey goal type required (B3)** changes a pad flow; the phone composition rules and the pad e2e apply.
- **W2c moves underneath.** It is still building (`2bcc66313b`). Re-pin at rebase, and send any W2c interface move
  through f-w2c.
- **Bench coordination** (B1) may sequence a bench helper change behind its own index.
- **Migration renumbering** across four branches (P6, D1).

## 17. Open items

**Left to the builder (minor; no owner input needed):**

- The exact pin hook per activation path, and the transaction placement.
- The SQL literals of the migration pin per sport, re-read from main at build (§8).
- Index and RLS details of `stage_lots_draws`; the `membersKey` encoding.
- Column order and labels for the new keys (4 locales); popover wording within §10's meanings.
- The implementation of IIHF's internal "fewest played" comparator and of `scheduledPairs`.
- The phone fold of the new section, following W2c's S1 pattern.

**Still needing the owner:** none. The builder-check round closed the four open questions (B2 shoot-out columns, B3
field goals, B4 volleyball double round robin, B5 chess SB), and B1 replaced the "no backfill" note.

**To put to the owner with the spec (non-blocking; each is already the design unless the owner says otherwise):**

1. **The orchestrator's calls** (§3): first step pinned to the primary measure (D11); Swiss exempt from the shape rule
   (OC1); pin at activation (OC2); only `h2h_two` may repeat (OC3).
2. **The author's calls** flagged above: the generic ST-G12 skip for non-IIHF sports (§5.6); cricket and chess `so`
   mappings as `result` (§5.2); `direct` reading game points under 3/1/0 alongside SB (§5.6); the football preset menu
   and the read-only cross-group line (§9, §5.9); the margin-bonus fix inside W2d (§2.1 #15); chess 3/1/0 only on
   non-Swiss stages (§5.3); the volleyball guard reading (§5.3); the tennis `h2h_two` interleave (§5.10); the pin
   stored as columns (§5.4); FIH `wins` also excluding an `ot` win where a stage enables overtime (§5.6, extending B2's
   "regulation wins only"); refusing an untyped hockey goal at the engine (§5.6).

## Appendix A — Rule rows to sign at plan start (ruling 75)

Ids as written: cricket CK-, carrom CA- (file prefixes); signed 2026-10-24.

These ids are proposed and checked free in both trees (no existing `*-TB-*`; `X-PT-1` and `X-SR-1..7` are W2c's). The
wording is finalised with the owner at plan start. Statuses become `signed <ruling> <date>` or `deviation <ruling>
<date>` at the fold.

- `cross-sport.md`:
  - **X-TB-1** a stage ranks by its own order, else its division's default, else its sport's default for its stage
    kind.
  - **X-TB-2** when a stage becomes active it pins its points rule and order; later division or sport default
    changes reach only unpinned stages. Its own order and points lock at its first score. Stages already active when
    this rule ships are pinned to the rules they used before it (B1).
  - **X-TB-3** every non-Swiss order starts with the sport's primary measure and ends with a drawing of lots (Swiss
    orders are W3's). No step appears twice, except "head-to-head between two", which may follow several steps.
  - **X-TB-4** a drawing of lots is seeded, stored, and reused whenever the same entrants are tied again.
  - **X-TB-5** a step the sport does not record, or the stage format has no data for, is refused when saved.
  - **X-TB-6** a table with no counted fixture has no leader and draws no lots.
  - **X-TB-7** teams from different groups are compared by the source stage's order without head-to-head steps.
  - **X-TB-8** a head-to-head step needs a complete mini-schedule; otherwise the sport's partial-schedule order
    applies, or the step does not split.
  - **X-PT-2** table points are keyed by result and how it was decided (regulation, overtime, shoot-out), derived from
    the recorded events; overtime pays a win or a loss unless split; a shoot-out pays per the sport (X-PT-4).
  - **X-PT-3** a stage's points must cover every outcome its format or any match override can produce.
  - **X-PT-4** a sport declares whether a shoot-out is a draw plus a bonus to its winner (football, hockey) or a result
    (ice hockey, cricket super over, chess rungs); in a knockout it only decides who advances.
  - **X-WO-1** (amended, D6).
- `football.md`:
  - **FB-PT-1** a group-stage shoot-out is a draw for both teams, and its winner gets a bonus point (RB2B-7, B2).
  - **FB-TB-1** default FIFA 2026 order (deviation: lots, RB2B-4).
  - **FB-TB-2** the UEFA preset re-applies head-to-head.
  - **FB-TB-3** UEFA 20.02 not offered (deviation, RB2B-5).
  - **FB-TB-4** fair play is a step only while the division tracks it.
- `hockey.md`:
  - **HK-PT-1** 3/1/0 with draws.
  - **HK-PT-2** the Pro League preset: a draw goes to a shoot-out; both get the draw point and the winner a bonus
    point (2/1) (B2).
  - **HK-TB-1** the FIH order with field goals (deviation: lots, RB2B-11); "matches won" counts regulation wins only
    (B2).
  - **HK-TB-2** a field goal is any goal not scored from a penalty corner or a penalty stroke; own goals count, and
    every goal records its type (B3).
- `icehockey.md`:
  - **IH-PT-1** IIHF 3/2/1/0 for OT and GWS.
  - **IH-PT-2** recreational 2/1/0.
  - **IH-TB-1** IIHF order with re-application (deviation: steps 4–5, RB2B-12).
  - **IH-TB-2** the partial-schedule order.
- `boardgame.md`:
  - **BG-PT-1** 1/½/0 shown in half-points; 3/1/0 per round-robin stage.
  - **BG-TB-1** the round-robin order.
  - **BG-TB-2** no Buchholz outside Swiss.
  - **BG-TB-3** Sonneborn-Berger and direct encounter use game points (1/½/0), also when the stage pays 3/1/0 (B5).
- `cricket.md`:
  - **CR-PT-1** 2/1/1/0, with tie and NR editable.
  - **CR-PT-2** a two-innings draw pays 1.
  - **CR-TB-1** the ICC order, then lots (deviation).
- `volleyball.md`:
  - **VB-PT-1** FIVB best of 5.
  - **VB-PT-2** best of 3: 2-1 ⇒ 2:1, 2-0 ⇒ 3:0 (product rule, FIVB silent).
  - **VB-PT-3** a split map names every reachable score.
  - **VB-TB-1** wins first.
  - **VB-TB-2** in a double round robin, head-to-head aggregates both legs (deviation from "the last match", RBS:295;
    B4).
- `badminton.md`:
  - **BD-TB-1** BWF 16.2.
- `tabletennis.md`:
  - **TT-PT-1** 2/1/0, unplayed loss 0.
  - **TT-TB-1** a mini-league among the tied with exclusion, then lots.
- `tennis.md`:
  - **TN-TB-1** ATP 4.01 C.3 (deviation: lots).
  - **TN-TB-2** a won match tie-break counts as one set and one game.
- `carrom.md`, `generic.md`:
  - **CM-TB-1 / GN-TB-1** the product order, ending in lots.
